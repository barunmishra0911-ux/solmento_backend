import dns from "node:dns/promises";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { URL } from "node:url";
import { env } from "../config/env.js";

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2_000_000; // 2MB max per page

/**
 * Validates and sanitizes crawl page limit within safe bounds [1, CRAWL_HARD_CEILING_PAGES].
 */
export function sanitizeCrawlLimit(requestedLimit) {
  const defaultLimit = Number(env.CRAWL_DEFAULT_MAX_PAGES) || 50;
  const hardCeiling = Number(env.CRAWL_HARD_CEILING_PAGES) || 1000;

  if (requestedLimit === undefined || requestedLimit === null || requestedLimit === "") {
    return defaultLimit;
  }

  const parsed = Number(requestedLimit);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultLimit;
  }

  return Math.min(Math.max(Math.floor(parsed), 1), hardCeiling);
}

/**
 * Validates that an IP address is not private, loopback, or cloud metadata.
 */
export function isPrivateIp(ip) {
  if (!ip || typeof ip !== "string") return true;
  const cleanIp = ip.trim().toLowerCase();

  // IPv4 checks
  if (/^127\./.test(cleanIp)) return true;
  if (/^10\./.test(cleanIp)) return true;
  if (/^192\.168\./.test(cleanIp)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(cleanIp)) return true;
  if (/^169\.254\./.test(cleanIp)) return true; // Link-local / metadata
  if (cleanIp === "0.0.0.0" || cleanIp === "255.255.255.255") return true;

  // IPv6 checks
  if (cleanIp === "::1" || cleanIp === "::") return true;
  if (/^fe80:/i.test(cleanIp)) return true; // Link-local
  if (/^fc00:/i.test(cleanIp) || /^fd00:/i.test(cleanIp)) return true; // Unique local
  if (/^::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|169\.254\.)/i.test(cleanIp)) return true;

  return false;
}

/**
 * Validates URL safety against SSRF attacks.
 */
export async function validateSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}. Only http and https are allowed.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "metadata.google.internal"
  ) {
    throw new Error(`Disallowed host: ${hostname}`);
  }

  // Resolve hostname and check IP
  try {
    const lookup = await dns.lookup(hostname);
    if (isPrivateIp(lookup.address)) {
      throw new Error(`Host resolves to private IP address: ${lookup.address}`);
    }
  } catch (error) {
    if (error.message.includes("private IP")) throw error;
    throw new Error(`Unable to resolve host: ${hostname}`);
  }

  return parsed;
}

/**
 * Safe fetch with timeout, size limit, SSRF redirect validation,
 * and support for HTTP validators (ETag, Last-Modified, 304 Not Modified).
 */
export async function safeFetch(urlStr, options = {}) {
  if (options.fetchFn) {
    return options.fetchFn(urlStr, options);
  }
  await validateSafeUrl(urlStr);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const reqHeaders = {
    "User-Agent": "SolmentoAI-KnowledgeBot/2.0 (+https://solmento.tarule.in)",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    ...(options.headers || {}),
  };

  try {
    let response;
    try {
      response = await fetch(urlStr, {
        signal: controller.signal,
        redirect: "manual",
        headers: reqHeaders,
      });
    } catch (fetchErr) {
      const errMsg = (fetchErr?.message || "").toLowerCase();
      const causeMsg = (fetchErr?.cause?.message || "").toLowerCase();
      const causeCode = fetchErr?.cause?.code || fetchErr?.code || "";
      const isCertError =
        causeCode === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
        causeCode === "CERT_HAS_EXPIRED" ||
        errMsg.includes("certificate") ||
        errMsg.includes("signature") ||
        causeMsg.includes("certificate") ||
        causeMsg.includes("signature");

      if (isCertError) {
        // Fallback using undici dispatcher with rejectUnauthorized: false
        // SSRF protection has already passed validateSafeUrl above!
        const { Agent, fetch: uFetch } = await import("undici");
        const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
        response = await uFetch(urlStr, {
          signal: controller.signal,
          redirect: "manual",
          headers: reqHeaders,
          dispatcher,
        });
      } else {
        throw fetchErr;
      }
    }

    // Check redirect safety manually (skip 304 which has no location redirect)
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect with missing Location header from ${urlStr}`);
      const resolvedRedirect = new URL(location, urlStr).toString();
      await validateSafeUrl(resolvedRedirect);
      return safeFetch(resolvedRedirect, options);
    }

    // HTTP 304 Not Modified — server asserts content is unchanged under validator
    if (response.status === 304) {
      return {
        notModified: true,
        status: 304,
        finalUrl: urlStr,
        etag: response.headers.get("etag") || options.headers?.["If-None-Match"] || null,
        lastModified: response.headers.get("last-modified") || options.headers?.["If-Modified-Since"] || null,
      };
    }

    // HTTP 404 / 410 — confirmed permanent removal
    if (response.status === 404 || response.status === 410) {
      return {
        notFound: true,
        status: response.status,
        finalUrl: urlStr,
      };
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${urlStr}`);
    }

    const contentType = response.headers.get("content-type") || "";
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_BYTES * 5) {
      throw new Error(`Response too large: ${contentLength} bytes`);
    }

    const arrayBuf = await response.arrayBuffer();
    const rawBuf = Buffer.from(arrayBuf);
    let text = "";

    // Decompress if gzip magic header (0x1f, 0x8b) detected (e.g. sitemap.xml.gz)
    if (rawBuf.length >= 2 && rawBuf[0] === 0x1f && rawBuf[1] === 0x8b) {
      try {
        text = zlib.gunzipSync(rawBuf).toString("utf-8");
      } catch {
        text = rawBuf.toString("utf-8");
      }
    } else {
      text = rawBuf.toString("utf-8");
    }

    if (text.length > MAX_BYTES * 5) {
      text = text.slice(0, MAX_BYTES * 5);
    }

    return {
      text,
      contentType,
      finalUrl: urlStr,
      status: response.status,
      etag: response.headers.get("etag") || null,
      lastModified: response.headers.get("last-modified") || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decode common HTML entities.
 */
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Extracts clean, readable text from HTML markup, preserving useful anchor links.
 */
export function extractCleanContent(html, baseUrl = "") {
  if (!html) return { title: "", text: "" };

  // 1. Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : "";

  // 2. Remove script, style, nav, header, footer, noscript, svg, iframe
  let cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // 3. Preserve meaningful anchor links: anchorText (url)
  cleaned = cleaned.replace(/<a\s+(?:[^>]*?\s+)?href=["']([^"'#\s]+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, anchorText) => {
    const cleanAnchor = anchorText.replace(/<[^>]+>/g, "").trim();
    if (!cleanAnchor) return "";
    let fullUrl = href.trim();
    if (
      fullUrl.startsWith("javascript:") ||
      fullUrl.startsWith("mailto:") ||
      fullUrl.startsWith("tel:") ||
      fullUrl === "#"
    ) {
      return cleanAnchor;
    }
    try {
      if (baseUrl) {
        fullUrl = new URL(fullUrl, baseUrl).toString();
      }
    } catch {
      // keep fullUrl as is
    }
    return `${cleanAnchor} (${fullUrl})`;
  });

  // 4. Replace headings, paragraphs, list items, table rows with spacing
  cleaned = cleaned
    .replace(/<\/(h[1-6]|p|div|li|tr|section|article)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n");

  // 5. Strip all remaining tags
  cleaned = cleaned.replace(/<[^>]+>/g, " ");

  // 6. Decode entities and normalize spaces
  cleaned = decodeHtmlEntities(cleaned)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();

  return { title, text: cleaned };
}

/**
 * Checks if the XML document is a sitemap index containing child sitemaps.
 */
export function isSitemapIndex(xml) {
  if (!xml || typeof xml !== "string") return false;
  return /<sitemapindex[\s>]/i.test(xml) || /<sitemap[\s>]/i.test(xml);
}

/**
 * Extracts child sitemap URLs from a sitemap index XML document.
 */
export function extractChildSitemapUrls(xml) {
  if (!xml) return [];
  const urls = [];
  const sitemapBlockRegex = /<sitemap[\s\S]*?<\/sitemap>/gi;
  let match;
  while ((match = sitemapBlockRegex.exec(xml)) !== null) {
    const locMatch = match[0].match(/<loc\s*>\s*([\s\S]*?)\s*<\/loc\s*>/i);
    if (locMatch) {
      const clean = locMatch[1].replace(/<!\[CDATA\[/gi, "").replace(/\]\]>/g, "").trim();
      if (/^https?:\/\//i.test(clean)) {
        urls.push(clean);
      }
    }
  }
  return urls;
}

/**
 * Parses XML sitemaps to discover candidate URLs along with lastmod metadata.
 * Strips XML CDATA and handles namespaces gracefully.
 */
export function extractSitemapEntries(xml) {
  if (!xml) return [];
  const entries = [];
  const urlBlockRegex = /<url[\s\S]*?<\/url>/gi;
  let blockMatch;
  let hasBlocks = false;

  while ((blockMatch = urlBlockRegex.exec(xml)) !== null) {
    hasBlocks = true;
    const block = blockMatch[0];
    const locMatch = block.match(/<loc\s*>\s*([\s\S]*?)\s*<\/loc\s*>/i);
    const lastmodMatch = block.match(/<lastmod\s*>\s*([\s\S]*?)\s*<\/lastmod\s*>/i);
    if (locMatch) {
      const cleanUrl = locMatch[1].replace(/<!\[CDATA\[/gi, "").replace(/\]\]>/g, "").trim();
      const cleanLastmod = lastmodMatch ? lastmodMatch[1].replace(/<!\[CDATA\[/gi, "").replace(/\]\]>/g, "").trim() : null;
      if (/^https?:\/\//i.test(cleanUrl)) {
        entries.push({
          url: cleanUrl,
          lastmod: cleanLastmod,
        });
      }
    }
  }

  // Fallback if no <url> blocks (and not a sitemap index)
  if (!hasBlocks && !isSitemapIndex(xml)) {
    const locRegex = /<loc\s*>\s*([\s\S]*?)\s*<\/loc\s*>/gi;
    let locMatch;
    while ((locMatch = locRegex.exec(xml)) !== null) {
      const cleanUrl = locMatch[1].replace(/<!\[CDATA\[/gi, "").replace(/\]\]>/g, "").trim();
      if (/^https?:\/\//i.test(cleanUrl)) {
        entries.push({ url: cleanUrl, lastmod: null });
      }
    }
  }

  return entries;
}

/**
 * Backward-compatible helper extracting raw URLs from sitemap.
 */
export function extractUrlsFromSitemap(xml) {
  return extractSitemapEntries(xml).map((e) => e.url);
}

/**
 * Computes SHA-256 fingerprint for a sitemap inventory.
 */
export function computeSitemapHash(entries) {
  const normalized = (entries || [])
    .map((e) => `${e.url}|${e.lastmod || ""}`)
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * Safely checks if a target hostname matches the base hostname (ignoring 'www.')
 * or matches any explicitly approved domains/subdomains.
 */
export function isAllowedHost(targetHostname, baseHostname, approvedDomains = []) {
  if (!targetHostname || !baseHostname) return false;
  const target = targetHostname.toLowerCase().replace(/^www\./, "");
  const base = baseHostname.toLowerCase().replace(/^www\./, "");
  if (target === base) return true;

  const approvedList = Array.isArray(approvedDomains)
    ? approvedDomains.map((d) => d.toLowerCase().trim().replace(/^www\./, ""))
    : [];

  return approvedList.some((domain) => target === domain || target.endsWith(`.${domain}`));
}

/**
 * Extracts links from HTML belonging to the same host (or approved domains if configured).
 */
export function extractInternalLinks(html, baseUrl, options = {}) {
  const base = new URL(baseUrl);
  const links = new Set();
  const linkRegex = /<a\s+(?:[^>]*?\s+)?href=["']([^"'#\s]+)["']/gi;
  let match;
  const approvedDomains = Array.isArray(options.approvedDomains)
    ? options.approvedDomains
    : [];

  while ((match = linkRegex.exec(html)) !== null) {
    try {
      const resolved = new URL(match[1], baseUrl);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;

      const isAllowed = isAllowedHost(resolved.hostname, base.hostname, approvedDomains);

      if (isAllowed) {
        if (!/\.(png|jpg|jpeg|gif|svg|pdf|zip|rar|mp4|mp3|css|js|webp)$/i.test(resolved.pathname)) {
          resolved.hash = "";
          links.add(resolved.toString());
        }
      }
    } catch { }
  }

  return Array.from(links);
}

/**
 * Normalizes content hash for change detection.
 */
export function computeContentHash(text) {
  return crypto.createHash("sha256").update(text.trim()).digest("hex");
}

/**
 * Change-detection crawler orchestrator for a given website.
 * Efficiently discovers pages, leverages HTTP validators (304),
 * falls back to normalized content hashes, and identifies NEW, CHANGED,
 * UNCHANGED, REMOVED, and FAILED pages.
 *
 * @param {string} targetUrl - Initial website or sitemap URL.
 * @param {object} options
 * @param {Array} options.existingPages - List of existing page records from DB.
 * @param {number} options.maxPages - Maximum pages to inspect per run.
 */
export async function runChangeDetectionCrawl(targetUrl, options = {}) {
  const maxPages = sanitizeCrawlLimit(options.maxPages ?? options.crawlLimit);
  const initialUrlObj = options.fetchFn ? new URL(targetUrl) : await validateSafeUrl(targetUrl);
  const baseOrigin = initialUrlObj.origin;

  // Build lookup map of existing pages: canonical URL -> page record
  const existingMap = new Map();
  for (const page of options.existingPages || []) {
    existingMap.set(page.url, page);
  }

  const candidateUrls = new Set();
  const visitedUrls = new Set();
  let sitemapEntries = [];
  let sitemapHash = null;

  const isExplicitSitemap =
    targetUrl.toLowerCase().endsWith(".xml") ||
    targetUrl.toLowerCase().endsWith(".xml.gz") ||
    targetUrl.toLowerCase().includes("sitemap");

  const resolveSitemapUrls = async (xmlText) => {
    let entries = [];
    if (isSitemapIndex(xmlText)) {
      const childSitemaps = extractChildSitemapUrls(xmlText);
      const allowedChildSitemaps = childSitemaps
        .filter((childUrl) => {
          try {
            const parsed = new URL(childUrl);
            return isAllowedHost(parsed.hostname, initialUrlObj.hostname, options.approvedDomains);
          } catch {
            return false;
          }
        })
        .sort((a, b) => {
          // Prioritize English / main doc sitemaps first
          const aLower = a.toLowerCase();
          const bLower = b.toLowerCase();
          const aEng = aLower.includes("en-us") || aLower.includes("/en/") || aLower.includes("docs");
          const bEng = bLower.includes("en-us") || bLower.includes("/en/") || bLower.includes("docs");
          if (aEng && !bEng) return -1;
          if (!aEng && bEng) return 1;
          return 0;
        })
        .slice(0, 25);

      for (const childUrl of allowedChildSitemaps) {
        try {
          const childRes = await safeFetch(childUrl, { fetchFn: options.fetchFn });
          if (!childRes.notFound && childRes.text) {
            entries.push(...extractSitemapEntries(childRes.text));
          }
        } catch (childErr) {
          console.warn(`[Crawler] Failed to fetch nested sitemap ${childUrl}:`, childErr.message);
        }
      }
    } else {
      entries = extractSitemapEntries(xmlText);
    }
    return entries;
  };

  // Step 1: Discover sitemap URLs & lastmod metadata
  if (isExplicitSitemap) {
    try {
      const res = await safeFetch(targetUrl, { fetchFn: options.fetchFn });
      if (!res.notFound && res.text) {
        sitemapEntries = await resolveSitemapUrls(res.text);
        for (const entry of sitemapEntries) {
          try {
            const parsed = new URL(entry.url);
            if (isAllowedHost(parsed.hostname, initialUrlObj.hostname, options.approvedDomains)) {
              candidateUrls.add(entry.url);
            }
          } catch { }
        }
        sitemapHash = computeSitemapHash(sitemapEntries);
      }
    } catch (err) {
      console.warn(`[Crawler] Explicit sitemap failed or not found at ${targetUrl}, falling back to site discovery:`, err.message);
    }
  }

  // If no candidates yet (or explicit sitemap failed/empty), inspect robots.txt and common sitemap endpoints
  if (candidateUrls.size === 0) {
    // 1. Try robots.txt for Sitemap: directives
    try {
      const robotsRes = await safeFetch(`${baseOrigin}/robots.txt`, { fetchFn: options.fetchFn });
      if (!robotsRes.notFound && robotsRes.text) {
        const sitemapMatches = robotsRes.text.matchAll(/^\s*Sitemap:\s*(https?:\/\/[^\s]+)/gim);
        for (const m of sitemapMatches) {
          const sUrl = m[1].trim();
          try {
            const sRes = await safeFetch(sUrl, { fetchFn: options.fetchFn });
            if (!sRes.notFound && sRes.text) {
              const smEntries = await resolveSitemapUrls(sRes.text);
              for (const e of smEntries) {
                try {
                  const parsed = new URL(e.url);
                  if (isAllowedHost(parsed.hostname, initialUrlObj.hostname, options.approvedDomains)) {
                    candidateUrls.add(e.url);
                  }
                } catch { }
              }
              if (candidateUrls.size > 0) {
                sitemapHash = computeSitemapHash(smEntries);
                break;
              }
            }
          } catch { }
        }
      }
    } catch { }

    // 2. Try common sitemap endpoints: standard, index, and WordPress
    if (candidateUrls.size === 0) {
      const sitemapCandidates = [
        `${baseOrigin}/sitemap.xml`,
        `${baseOrigin}/sitemap_index.xml`,
        `${baseOrigin}/wp-sitemap.xml`,
      ];

      for (const smUrl of sitemapCandidates) {
        try {
          const smRes = await safeFetch(smUrl, { fetchFn: options.fetchFn });
          if (!smRes.notFound && smRes.text) {
            const smEntries = await resolveSitemapUrls(smRes.text);
            if (smEntries.length > 0) {
              for (const entry of smEntries) {
                try {
                  const parsed = new URL(entry.url);
                  if (isAllowedHost(parsed.hostname, initialUrlObj.hostname, options.approvedDomains)) {
                    candidateUrls.add(entry.url);
                  }
                } catch { }
              }
              sitemapHash = computeSitemapHash(smEntries);
              break;
            }
          }
        } catch { }
      }
    }
  }

  // Always include the homepage / initial URL
  const initialPage = isExplicitSitemap
    ? (baseOrigin.endsWith("/") ? baseOrigin : `${baseOrigin}/`)
    : targetUrl;
  candidateUrls.add(initialPage);

  // Prioritize high-value pages: initialPage first, then documentation, products, admissions, services, etc.
  const priorityKeywords = [
    // Documentation / Software / Tech
    "doc", "docs", "documentation", "guide", "tutorial", "start", "getting-started", "install", "api",
    // Products / E-commerce / Catalog
    "product", "products", "item", "catalog", "pricing", "price", "shop", "shipping", "delivery", "return", "policy",
    // Healthcare / Medical / Clinic
    "service", "services", "department", "doctor", "doctors", "clinic", "appointment", "patient", "health", "treatment",
    // Education / Academics / Admissions
    "admission", "admissions", "program", "programs", "course", "courses", "fee", "fees", "eligibility", "academic", "apply", "scholarship", "degree",
    // General / Company Information
    "overview", "features", "about", "contact", "help", "faq", "terms", "privacy", "team"
  ];

  const sortedCandidates = Array.from(candidateUrls).sort((a, b) => {
    if (a === initialPage) return -1;
    if (b === initialPage) return 1;

    const lowerA = a.toLowerCase();
    const lowerB = b.toLowerCase();

    const scoreA = priorityKeywords.reduce((acc, kw) => acc + (lowerA.includes(kw) ? 1 : 0), 0);
    const scoreB = priorityKeywords.reduce((acc, kw) => acc + (lowerB.includes(kw) ? 1 : 0), 0);

    return scoreB - scoreA;
  });

  const results = {
    sitemapHash,
    totalDiscoveredCount: candidateUrls.size,
    discoveredCount: candidateUrls.size,
    processedCount: 0,
    isPartial: false,
    maxPages,
    newPages: [],
    changedPages: [],
    unchangedPages: [],
    removedPages: [],
    failedPages: [],
  };

  // Step 2: Process candidate URLs (bounded by maxPages) via dynamic queue with controlled concurrency
  const queue = [...sortedCandidates];
  const enqueuedUrls = new Set(sortedCandidates);
  const BATCH_CONCURRENCY = 4;

  const processUrl = async (pageUrl) => {
    const existing = existingMap.get(pageUrl);

    // Prepare conditional headers if existing validators are available
    const reqHeaders = {};
    if (existing?.etag) reqHeaders["If-None-Match"] = existing.etag;
    if (existing?.last_modified) reqHeaders["If-Modified-Since"] = existing.last_modified;

    try {
      const res = await safeFetch(pageUrl, { headers: reqHeaders, fetchFn: options.fetchFn });

      // Case A: 304 Not Modified
      if (res.notModified) {
        return {
          type: "UNCHANGED",
          page: {
            id: existing?.id,
            url: pageUrl,
            etag: res.etag || existing?.etag,
            lastModified: res.lastModified || existing?.last_modified,
            reason: "HTTP_304_NOT_MODIFIED",
          },
        };
      }

      // Case B: 404 / 410 Confirmed Removal
      if (res.notFound) {
        if (existing) {
          return {
            type: "REMOVED",
            page: {
              id: existing.id,
              url: pageUrl,
              status: res.status,
              reason: `HTTP_${res.status}_PERMANENT_REMOVAL`,
            },
          };
        }
        return null;
      }

      // Case C: 200 OK — Extract content and compute normalized hash
      const { title, text } = extractCleanContent(res.text, pageUrl);

      if (text.length < 50) {
        // Page has insufficient readable content, ignore
        return null;
      }

      const hash = computeContentHash(text);
      let pageResult = null;

      if (existing) {
        if (existing.content_hash === hash) {
          // Content is identical — skip re-indexing, update check metadata only
          pageResult = {
            type: "UNCHANGED",
            page: {
              id: existing.id,
              url: pageUrl,
              etag: res.etag || existing.etag,
              lastModified: res.lastModified || existing.last_modified,
              reason: "CONTENT_HASH_MATCH",
            },
          };
        } else {
          // Content has changed — update knowledge record
          pageResult = {
            type: "CHANGED",
            page: {
              id: existing.id,
              url: res.finalUrl || pageUrl,
              title: title || initialUrlObj.hostname,
              contentText: text,
              contentHash: hash,
              etag: res.etag,
              lastModified: res.lastModified,
              status: "INDEXED",
            },
          };
        }
      } else {
        // New page discovered
        pageResult = {
          type: "NEW",
          page: {
            url: res.finalUrl || pageUrl,
            title: title || initialUrlObj.hostname,
            contentText: text,
            contentHash: hash,
            etag: res.etag,
            lastModified: res.lastModified,
            status: "INDEXED",
          },
        };
      }

      // Discover internal links if bounded limit not yet reached
      if (enqueuedUrls.size < maxPages * 3) {
        const discovered = extractInternalLinks(res.text, pageUrl, options);
        for (const d of discovered) {
          if (!visitedUrls.has(d) && !enqueuedUrls.has(d)) {
            candidateUrls.add(d);
            enqueuedUrls.add(d);
            queue.push(d);
          }
        }
      }

      return pageResult;
    } catch (pageErr) {
      console.warn(`[Crawler] Transient failure fetching ${pageUrl}:`, pageErr.message);
      return {
        type: "FAILED",
        page: {
          url: pageUrl,
          error: pageErr.message,
          existingId: existing?.id || null,
        },
      };
    }
  };

  while (queue.length > 0 && visitedUrls.size < maxPages) {
    const batch = [];
    while (queue.length > 0 && visitedUrls.size + batch.length < maxPages && batch.length < BATCH_CONCURRENCY) {
      const pageUrl = queue.shift();
      if (visitedUrls.has(pageUrl) || batch.includes(pageUrl)) continue;
      batch.push(pageUrl);
    }

    if (batch.length === 0) break;

    for (const url of batch) {
      visitedUrls.add(url);
    }

    const batchResults = await Promise.all(batch.map((url) => processUrl(url)));

    for (const item of batchResults) {
      if (!item) continue;
      if (item.type === "UNCHANGED") results.unchangedPages.push(item.page);
      else if (item.type === "CHANGED") results.changedPages.push(item.page);
      else if (item.type === "NEW") results.newPages.push(item.page);
      else if (item.type === "REMOVED") results.removedPages.push(item.page);
      else if (item.type === "FAILED") results.failedPages.push(item.page);
    }
  }

  // Step 3: Check for confirmed removed pages absent from sitemap
  // Removal Policy: Only check pages that were previously INDEXED, are absent from the newly
  // discovered complete sitemap, AND have not been visited. Verify with a HEAD/GET request.
  if (sitemapEntries.length > 0 && candidateUrls.size > 0) {
    for (const [storedUrl, existingRecord] of existingMap.entries()) {
      if (existingRecord.status !== "INDEXED") continue;
      if (visitedUrls.has(storedUrl)) continue;

      // Verify whether the absent URL is truly 404/410
      try {
        const checkRes = await safeFetch(storedUrl, { fetchFn: options.fetchFn });
        if (checkRes.notFound) {
          results.removedPages.push({
            id: existingRecord.id,
            url: storedUrl,
            status: checkRes.status,
            reason: `HTTP_${checkRes.status}_CONFIRMED_ABSENT`,
          });
        }
      } catch {
        // Transient check error: do NOT remove! Preserve existing content.
      }
    }
  }

  results.totalDiscoveredCount = candidateUrls.size;
  results.discoveredCount = candidateUrls.size;
  results.processedCount = visitedUrls.size;
  results.isPartial =
    candidateUrls.size > maxPages ||
    (candidateUrls.size > visitedUrls.size && visitedUrls.size >= maxPages);

  return results;
}

/**
 * Backward-compatible wrapper for Phase 1 calls.
 */
export async function crawlWebsite(targetUrl, options = {}) {
  const result = await runChangeDetectionCrawl(targetUrl, options);
  const allIndexedPages = [
    ...result.newPages,
    ...result.changedPages,
  ];

  return {
    scannedCount: result.totalDiscoveredCount,
    discoveredCount: result.totalDiscoveredCount,
    processedCount: result.processedCount,
    indexedCount: allIndexedPages.length + result.unchangedPages.length,
    pages: allIndexedPages,
    unchangedCount: result.unchangedPages.length,
    removedCount: result.removedPages.length,
    failedCount: result.failedPages.length,
    isPartial: result.isPartial,
  };
}
