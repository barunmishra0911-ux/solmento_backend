import crypto from "node:crypto";
import { pool } from "../config/database.js";

/**
 * Computes canonical SHA-256 fingerprint for a website source.
 * Normalizes host by lowercasing and stripping leading 'www.'.
 */
export function computeSourceFingerprint(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return crypto.createHash("sha256").update(host).digest("hex");
  } catch {
    const cleaned = rawUrl.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    return crypto.createHash("sha256").update(cleaned).digest("hex");
  }
}

/**
 * Retrieves stored knowledge pages for a specific chatbot, optionally scoped by source fingerprint.
 */
export async function getChatbotKnowledgePages({ tenantId, chatbotId, sourceFingerprint }) {
  if (sourceFingerprint) {
    const [rows] = await pool.execute(
      `SELECT id, url, title, content_text, content_hash, etag, last_modified, status, last_checked_at, updated_at, source_fingerprint
         FROM chatbot_knowledge_pages
        WHERE tenant_id = ? AND chatbot_id = ? AND source_fingerprint = ?`,
      [tenantId, chatbotId, sourceFingerprint],
    );
    return rows;
  }
  const [rows] = await pool.execute(
    `SELECT id, url, title, content_text, content_hash, etag, last_modified, status, last_checked_at, updated_at, source_fingerprint
       FROM chatbot_knowledge_pages
      WHERE tenant_id = ? AND chatbot_id = ?`,
    [tenantId, chatbotId],
  );
  return rows;
}

/**
 * Saves or updates crawled pages for a specific chatbot and tenant with source fingerprint.
 * Uses ON DUPLICATE KEY UPDATE to prevent duplicate rows for the same chatbot and URL.
 */
export async function saveCrawledPages({ tenantId, chatbotId, pages, sourceFingerprint }) {
  if (!pages || !pages.length) return { savedCount: 0 };

  let savedCount = 0;
  for (const page of pages) {
    const fp = sourceFingerprint || page.sourceFingerprint || (page.url ? computeSourceFingerprint(page.url) : null) || "default";
    await pool.execute(
      `INSERT INTO chatbot_knowledge_pages
        (tenant_id, chatbot_id, url, title, content_text, content_hash, etag, last_modified, last_checked_at, status, source_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
       ON DUPLICATE KEY UPDATE
        title = VALUES(title),
        content_text = VALUES(content_text),
        content_hash = VALUES(content_hash),
        etag = VALUES(etag),
        last_modified = VALUES(last_modified),
        last_checked_at = CURRENT_TIMESTAMP,
        status = VALUES(status),
        source_fingerprint = COALESCE(VALUES(source_fingerprint), source_fingerprint),
        updated_at = CURRENT_TIMESTAMP`,
      [
        tenantId,
        chatbotId,
        page.url,
        page.title || "",
        page.contentText,
        page.contentHash,
        page.etag || null,
        page.lastModified || null,
        page.status || "INDEXED",
        fp,
      ],
    );
    savedCount++;
  }

  return { savedCount };
}

/**
 * Efficiently applies change-detection updates to knowledge pages:
 * - New pages are inserted as INDEXED under current source_fingerprint
 * - Changed pages update content, hash, validators, and updated_at
 * - Unchanged pages only update last_checked_at and validators (never re-indexed)
 * - Removed pages are set to INACTIVE (content preserved, excluded from search)
 */
export async function applyCrawlUpdates({ tenantId, chatbotId, updates, sourceFingerprint }) {
  const { newPages = [], changedPages = [], unchangedPages = [], removedPages = [] } = updates;

  // 1. Insert new pages with source fingerprint
  if (newPages.length > 0) {
    await saveCrawledPages({
      tenantId,
      chatbotId,
      pages: newPages,
      sourceFingerprint,
    });
  }

  // 2. Update changed pages
  for (const changed of changedPages) {
    await pool.execute(
      `UPDATE chatbot_knowledge_pages
          SET title = ?,
              content_text = ?,
              content_hash = ?,
              etag = ?,
              last_modified = ?,
              status = 'INDEXED',
              source_fingerprint = COALESCE(?, source_fingerprint),
              last_checked_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ? AND chatbot_id = ? AND (id = ? OR url = ?)`,
      [
        changed.title || "",
        changed.contentText,
        changed.contentHash,
        changed.etag || null,
        changed.lastModified || null,
        sourceFingerprint || null,
        tenantId,
        chatbotId,
        changed.id || 0,
        changed.url,
      ],
    );
  }

  // 3. Update unchanged pages (touch metadata ONLY, do not touch content_text or updated_at)
  for (const unchanged of unchangedPages) {
    await pool.execute(
      `UPDATE chatbot_knowledge_pages
          SET last_checked_at = CURRENT_TIMESTAMP,
              etag = COALESCE(?, etag),
              last_modified = COALESCE(?, last_modified),
              source_fingerprint = COALESCE(?, source_fingerprint)
        WHERE tenant_id = ? AND chatbot_id = ? AND (id = ? OR url = ?)`,
      [
        unchanged.etag || null,
        unchanged.lastModified || null,
        sourceFingerprint || null,
        tenantId,
        chatbotId,
        unchanged.id || 0,
        unchanged.url,
      ],
    );
  }

  // 4. Mark confirmed removed pages as INACTIVE (preserves stored content)
  for (const removed of removedPages) {
    await pool.execute(
      `UPDATE chatbot_knowledge_pages
          SET status = 'INACTIVE',
              last_checked_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ? AND chatbot_id = ? AND (id = ? OR url = ?)`,
      [tenantId, chatbotId, removed.id || 0, removed.url],
    );
  }

  return {
    newCount: newPages.length,
    changedCount: changedPages.length,
    unchangedCount: unchangedPages.length,
    removedCount: removedPages.length,
  };
}

/**
 * Returns knowledge status and count of indexed and inactive pages for a chatbot,
 * optionally filtered by source fingerprint.
 */
export async function getChatbotKnowledgeStats({ tenantId, chatbotId, sourceFingerprint }) {
  if (sourceFingerprint) {
    const [rows] = await pool.execute(
      `SELECT COUNT(CASE WHEN status = 'INDEXED' THEN 1 END) as totalPages,
              COUNT(CASE WHEN status = 'INACTIVE' THEN 1 END) as inactivePages,
              MAX(updated_at) as lastCrawledAt,
              MAX(last_checked_at) as lastCheckedAt
         FROM chatbot_knowledge_pages
        WHERE tenant_id = ? AND chatbot_id = ? AND source_fingerprint = ?`,
      [tenantId, chatbotId, sourceFingerprint],
    );
    const row = rows[0] || {};
    return {
      totalPages: Number(row.totalPages || 0),
      inactivePages: Number(row.inactivePages || 0),
      lastCrawledAt: row.lastCrawledAt || null,
      lastCheckedAt: row.lastCheckedAt || null,
    };
  }

  const [rows] = await pool.execute(
    `SELECT COUNT(CASE WHEN status = 'INDEXED' THEN 1 END) as totalPages,
            COUNT(CASE WHEN status = 'INACTIVE' THEN 1 END) as inactivePages,
            MAX(updated_at) as lastCrawledAt,
            MAX(last_checked_at) as lastCheckedAt
       FROM chatbot_knowledge_pages
      WHERE tenant_id = ? AND chatbot_id = ?`,
    [tenantId, chatbotId],
  );

  const row = rows[0] || {};
  return {
    totalPages: Number(row.totalPages || 0),
    inactivePages: Number(row.inactivePages || 0),
    lastCrawledAt: row.lastCrawledAt || null,
    lastCheckedAt: row.lastCheckedAt || null,
  };
}

/**
 * Tokenize a search query into meaningful words (excluding short stopwords).
 */
const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "all", "am", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
  "can", "could", "did", "do", "does", "doing", "down", "during", "each", "few", "for",
  "from", "further", "had", "has", "have", "having", "he", "her", "here", "hers", "herself",
  "him", "himself", "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself",
  "just", "me", "more", "most", "my", "myself", "no", "nor", "not", "now", "of", "off",
  "on", "once", "only", "or", "other", "our", "ours", "ourselves", "out", "over", "own",
  "same", "she", "should", "so", "some", "such", "than", "that", "the", "their", "theirs",
  "them", "themselves", "then", "there", "these", "they", "this", "those", "through", "to",
  "too", "under", "until", "up", "very", "was", "we", "were", "what", "when", "where",
  "which", "while", "who", "whom", "why", "will", "with", "would", "you", "your", "yours",
]);

/**
 * Decompose camelCase, PascalCase, or hyphenated/underscored words into sub-tokens
 * (e.g. "useEffect" -> ["useeffect", "use", "effect"], "productSub" -> ["productsub", "product", "sub"]).
 */
export function decomposeCamelCaseTokens(tokens) {
  const result = new Set();
  for (const t of tokens) {
    const raw = String(t || "").trim();
    if (!raw) continue;
    result.add(raw.toLowerCase());
    const parts = raw
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[-_]/g, " ")
      .toLowerCase()
      .split(/\s+/);
    if (parts.length > 1) {
      for (const p of parts) {
        if (p.length >= 2) result.add(p);
      }
    }
  }
  return Array.from(result);
}

/**
 * Clean and normalize a sub-concept phrase extracted from a query.
 */
export function cleanConcept(str) {
  if (!str) return "";
  const c = str
    .trim()
    .replace(/[?!.,;:]+$/, "")
    .replace(/^(?:the|a|an|about|both|what|how|why|tell\s+me\s+about)\s+/i, "")
    .replace(/\s+(?:together|work|mean|work together)$/i, "")
    .trim();
  return c.length >= 2 ? c : "";
}

/**
 * Generic multi-concept query extractor.
 * Detects distinct topics or concepts in compound user questions:
 * - "between X and Y"
 * - Conjunctions: "and", "or", "vs", "versus", "as well as", "along with", "compared to", "+", "&"
 * - Punctuation / multi-clause: commas, semicolons, question marks
 * Works universally across technical documentation, healthcare, e-commerce, SaaS, education, etc.
 */
export function extractQueryConcepts(query) {
  if (!query || typeof query !== "string") return [];
  const cleaned = query.trim().replace(/[?!.]+$/, "");

  // Pattern 1: "between X and Y" / "difference between X and Y"
  const betweenMatch = cleaned.match(/between\s+([^,]+?)\s+(?:and|vs|versus)\s+([^,?.!]+)/i);
  if (betweenMatch) {
    const c1 = cleanConcept(betweenMatch[1]);
    const c2 = cleanConcept(betweenMatch[2]);
    if (c1 && c2 && c1 !== c2) return [c1, c2];
  }

  // Pattern 2: Strip interrogative lead-ins
  const stripped = cleaned.replace(
    /^(?:what\s+(?:is|are)|how\s+(?:do|does|can|to)|explain|tell\s+me\s+about|describe|compare|difference\s+between)\s+/i,
    "",
  );

  // Pattern 3: Conjunction splitters
  const parts = stripped.split(
    /\s+(?:and|or|vs|versus|as well as|along with|compared to|\+|&)\s+|\s*,\s*/i,
  );
  const concepts = parts.map(cleanConcept).filter(Boolean);

  if (concepts.length >= 2) {
    const unique = Array.from(new Set(concepts));
    if (unique.length >= 2) return unique;
  }

  return [cleanConcept(cleaned) || cleaned];
}

/**
 * Tokenize a search query into lowercase words.
 */
export function tokenizeQuery(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

/**
 * Filters out common stopwords from query tokens to emphasize meaningful terms,
 * decomposing camelCase tokens for complete coverage.
 */
export function getMeaningfulTokens(query) {
  const rawTokens = tokenizeQuery(query);
  const decomposed = decomposeCamelCaseTokens(rawTokens);
  const meaningful = decomposed.filter((t) => !STOPWORDS.has(t));
  return meaningful.length > 0 ? meaningful : decomposed;
}

/**
 * Expands search tokens with morphological base stems and common suffix variations
 * (e.g. cardiologist -> cardiolog, cardio; admissions -> admission, admit; policies -> policy; effect -> effects).
 */
export function expandSearchTokens(tokens) {
  const expanded = new Set();
  for (const raw of tokens) {
    const t = String(raw).toLowerCase().trim();
    if (!t) continue;
    expanded.add(t);

    // Common pluralization / suffix addition
    if (t.length >= 3 && !t.endsWith("s")) {
      expanded.add(t + "s");
    }

    if (t.length >= 5) {
      if (t.endsWith("ologists")) {
        expanded.add(t.slice(0, -4)); // cardiolog
        expanded.add(t.slice(0, -6)); // cardio
      } else if (t.endsWith("ologist")) {
        expanded.add(t.slice(0, -3)); // cardiolog
        expanded.add(t.slice(0, -5)); // cardio
      } else if (t.endsWith("ologies")) {
        expanded.add(t.slice(0, -4));
        expanded.add(t.slice(0, -6));
      } else if (t.endsWith("ology")) {
        expanded.add(t.slice(0, -3)); // cardiolog
        expanded.add(t.slice(0, -5)); // cardio
      } else if (t.endsWith("ological")) {
        expanded.add(t.slice(0, -6));
      } else if (t.endsWith("ies")) {
        expanded.add(t.slice(0, -3) + "y"); // policies -> policy
        expanded.add(t.slice(0, -3));
      } else if (t.endsWith("ing")) {
        expanded.add(t.slice(0, -3)); // troubleshooting -> troubleshoot
      } else if (t.endsWith("ations")) {
        expanded.add(t.slice(0, -6));
        expanded.add(t.slice(0, -4));
      } else if (t.endsWith("ation")) {
        expanded.add(t.slice(0, -5)); // registration -> registr
        expanded.add(t.slice(0, -3)); // registration -> registrat
      } else if (t.endsWith("ments")) {
        expanded.add(t.slice(0, -5));
        expanded.add(t.slice(0, -1));
      } else if (t.endsWith("ment")) {
        expanded.add(t.slice(0, -4));
      } else if (t.endsWith("s") && !t.endsWith("ss")) {
        expanded.add(t.slice(0, -1)); // headphones -> headphone, features -> feature
      }
    }
  }

  return Array.from(expanded).filter((w) => w.length >= 3);
}

/**
 * Extract relevant excerpt windows around matching query terms with:
 * - Multi-token co-occurrence scoring (drastically elevates paragraphs covering multiple query concepts)
 * - Heading and section title boosting
 * - Explanatory prose weighting (favors descriptive explanations over raw import/code fragments)
 * - Generous window expansion (defaults to 1800 chars to retain surrounding context and examples)
 */
export function extractRelevantWindow(content, rawQuery, maxExcerptLength = 1800) {
  if (!content) return "";

  const paragraphs = content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!paragraphs.length) return content.slice(0, maxExcerptLength).trim() + "...";
  if (content.length <= maxExcerptLength && paragraphs.length <= 2) return content.trim();

  const meaningful = getMeaningfulTokens(rawQuery);
  const expanded = expandSearchTokens(meaningful);
  const rawLower = String(rawQuery || "").toLowerCase().trim();
  const asksForUrlOrDoc = /where|link|url|doc|documentation|find|guide|site|help|start/i.test(rawLower);

  let bestScore = -1;
  let bestIdx = 0;

  paragraphs.forEach((p, idx) => {
    const pLower = p.toLowerCase();
    let score = 0;

    // 1. Co-occurrence of distinct meaningful query tokens in this paragraph
    const matchedTokens = new Set();
    for (const t of meaningful) {
      if (pLower.includes(t)) matchedTokens.add(t);
    }
    for (const t of expanded) {
      if (pLower.includes(t)) matchedTokens.add(t);
    }

    if (matchedTokens.size > 1) {
      // Quadratic co-occurrence bonus: rewards answering multiple concepts together
      score += Math.pow(matchedTokens.size, 2) * 20;
    }

    // 2. Token frequency scoring
    for (const t of expanded) {
      if (pLower.includes(t)) {
        const isOriginal = meaningful.includes(t);
        score += isOriginal ? 5 : 3;
        const matches = (pLower.match(new RegExp(`\\b${t}`, "g")) || []).length;
        score += Math.min(matches, 3);
      }
    }

    // 3. Exact phrase match bonus
    if (rawLower.length > 5 && pLower.includes(rawLower)) {
      score += 40;
    }

    // 4. Heading / Section title match bonus
    // Detect markdown headings or leading title-like lines
    const lines = p.split("\n");
    for (const line of lines.slice(0, 2)) {
      const lineTrim = line.trim();
      if (lineTrim.length < 80 && (lineTrim.startsWith("#") || /^[A-Z]/.test(lineTrim))) {
        for (const t of meaningful) {
          if (lineTrim.toLowerCase().includes(t)) score += 35;
        }
      }
    }

    // 5. Explanatory prose bonus vs. raw code/import penalty
    const proseWords = p
      .split(/\s+/)
      .filter(
        (w) =>
          /^[a-zA-Z]{3,}$/.test(w) &&
          !["const", "let", "var", "function", "return", "import", "from", "export", "default"].includes(
            w.toLowerCase(),
          ),
      ).length;

    if (proseWords >= 8) {
      score += 35;
    } else if (proseWords < 3 && (p.startsWith("import ") || p.includes("from '") || p.includes('from "'))) {
      score -= 35; // Strongly penalize bare import statements when explanatory text exists
    }

    // 6. Substantive explanatory phrases
    if (
      pLower.includes("is known as") ||
      pLower.includes("known as") ||
      pLower.includes("to do it") ||
      pLower.includes("let you") ||
      pLower.includes("lets you") ||
      pLower.includes("allows you") ||
      pLower.includes("is a") ||
      pLower.includes("is an") ||
      pLower.includes("used to") ||
      pLower.includes("used for") ||
      pLower.includes("designed to") ||
      pLower.includes("synchronize") ||
      pLower.includes("in this chapter")
    ) {
      score += 30;
    }

    // 7. Specific documentation target bonus when seeking docs/links
    if (
      asksForUrlOrDoc &&
      (pLower.includes("docs.") ||
        pLower.includes("/docs") ||
        pLower.includes("documentation (") ||
        pLower.includes("installation guide") ||
        pLower.includes("tutorial"))
    ) {
      score += 30;
    }

    // 8. Navigation / boilerplate penalty
    if (
      pLower.includes("toggle theme") ||
      pLower.includes("skip to main content") ||
      pLower.includes("main navigation") ||
      pLower.includes("merchandise store") ||
      pLower.includes("corporate membership") ||
      pLower.includes("&copy;") ||
      pLower.includes("hosting by") ||
      pLower.includes("design by") ||
      pLower.includes("trademark") ||
      pLower.includes("all rights reserved")
    ) {
      score -= 50;
    }

    // 9. Early content position bonus (definitions, core overviews)
    if (idx < 5) {
      score += (5 - idx) * 1.5;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  });

  // Expand around bestIdx to comfortably fill maxExcerptLength
  let snippet = paragraphs[bestIdx];
  let prev = bestIdx - 1;
  let next = bestIdx + 1;

  // 1. Prepend immediate heading or intro line if present
  if (prev >= 0 && (paragraphs[prev].length < 100 || paragraphs[prev].startsWith("#"))) {
    const prevLower = paragraphs[prev].toLowerCase();
    if (!prevLower.includes("&copy;") && !prevLower.includes("toggle theme") && !prevLower.includes("all rights reserved")) {
      snippet = paragraphs[prev] + "\n\n" + snippet;
      prev--;
    }
  }

  // 2. Expand forwards first (subsequent paragraphs elaborate the concept, code examples, or rules)
  while (next < paragraphs.length && snippet.length + paragraphs[next].length + 2 <= maxExcerptLength) {
    const nextLower = paragraphs[next].toLowerCase();
    if (
      nextLower.includes("&copy;") ||
      nextLower.includes("all rights reserved") ||
      nextLower.includes("toggle theme") ||
      nextLower.includes("skip to main content")
    ) {
      break;
    }
    snippet = snippet + "\n\n" + paragraphs[next];
    next++;
  }

  // 3. Prepend remaining context if space allows and avoid previous-topic footers
  while (prev >= 0 && snippet.length + paragraphs[prev].length + 2 <= maxExcerptLength) {
    const prevLower = paragraphs[prev].toLowerCase();
    if (
      paragraphs[prev].includes("Read More") ||
      paragraphs[prev].includes("Show more") ||
      prevLower.includes("&copy;") ||
      prevLower.includes("toggle theme") ||
      prevLower.includes("all rights reserved")
    ) {
      break;
    }
    snippet = paragraphs[prev] + "\n\n" + snippet;
    prev--;
  }

  return snippet.trim();
}

/**
 * Score a candidate page for relevance given query tokens and concepts:
 * - Co-occurrence of query concepts in the page
 * - Page title matches (Requirement 5)
 * - URL path relevance
 * - Definitional patterns in text
 */
function scoreCandidatePage(page, meaningfulTokens, conceptStr) {
  const titleLower = (page.title || "").toLowerCase();
  const textLower = (page.content_text || "").toLowerCase();
  let score = Number(page.score || 0);

  // 1. Co-occurrence of distinct meaningful tokens in page
  const matchedTokens = new Set();
  for (const t of meaningfulTokens) {
    if (textLower.includes(t)) matchedTokens.add(t);
  }
  if (matchedTokens.size > 1) {
    score += Math.pow(matchedTokens.size, 2) * 25;
  }

  // 2. Page title matches (strong boost)
  for (const t of meaningfulTokens) {
    if (titleLower.includes(t)) score += 40;
  }

  // 3. URL path relevance
  try {
    const parsed = new URL(page.url);
    const path = parsed.pathname.toLowerCase();
    for (const t of meaningfulTokens) {
      if (path.includes(t)) score += 20;
    }
  } catch {}

  // 4. Concept-specific definitional and heading matches
  const cLower = String(conceptStr || "").toLowerCase().trim();
  if (cLower.length >= 3) {
    if (
      textLower.includes(`${cLower} is a`) ||
      textLower.includes(`${cLower} is an`) ||
      textLower.includes(`${cLower} lets you`) ||
      textLower.includes(`${cLower} allows you`) ||
      textLower.includes(`${cLower} provides`) ||
      textLower.includes(`${cLower} hook`) ||
      textLower.includes(`about ${cLower}`) ||
      textLower.includes(`using ${cLower}`) ||
      textLower.includes(`${cLower} overview`) ||
      textLower.includes(`${cLower} guide`) ||
      textLower.includes(`${cLower} department`) ||
      textLower.includes(`${cLower} clinic`) ||
      textLower.includes(`${cLower} service`)
    ) {
      score += 80;
    }

    for (const t of meaningfulTokens) {
      if (t.length >= 4) {
        if (
          textLower.includes(`${t}s let you`) ||
          textLower.includes(`${t} let you`) ||
          textLower.includes(`synchronizing with ${t}s`) ||
          textLower.includes(`synchronize with ${t}s`) ||
          textLower.includes(`lifting ${t} up`) ||
          textLower.includes(`sharing ${t} between`)
        ) {
          score += 70;
        }
      }
    }
  }

  // 5. Term frequency (capped)
  for (const t of meaningfulTokens) {
    const occurrences = (textLower.match(new RegExp(`\\b${t}`, "g")) || []).length;
    score += Math.min(occurrences, 25) * 2;
  }

  return score;
}

/**
 * Helper to fetch and rank candidates for a specific search string.
 * Strictly scoped to tenant_id, chatbot_id, active source_fingerprint, and status = 'INDEXED'.
 */
async function fetchCandidatesForConcept({
  tenantId,
  chatbotId,
  activeFingerprint,
  concept,
  limit = 8,
}) {
  const meaningful = getMeaningfulTokens(concept);
  const searchTokens = expandSearchTokens(meaningful);

  if (!searchTokens.length) return [];

  let rows = [];

  // Try FULLTEXT
  try {
    const ftQuery = searchTokens.map((t) => `${t}*`).join(" ");
    const [ftRows] = await pool.execute(
      `SELECT id, url, title, content_text,
              MATCH(title, content_text) AGAINST (? IN BOOLEAN MODE) as score
         FROM chatbot_knowledge_pages
        WHERE tenant_id = ? AND chatbot_id = ? AND status = 'INDEXED' AND source_fingerprint = ?
          AND MATCH(title, content_text) AGAINST (? IN BOOLEAN MODE)
        ORDER BY score DESC
        LIMIT ?`,
      [ftQuery, tenantId, chatbotId, activeFingerprint, ftQuery, limit],
    );
    rows = ftRows;
  } catch {
    // FULLTEXT fallback
  }

  // Augment with LIKE if fewer than required
  if (rows.length < limit) {
    const existingIds = new Set(rows.map((r) => r.id));
    const likeClauses = searchTokens.slice(0, 6).map(() => "(title LIKE ? OR content_text LIKE ?)").join(" OR ");
    const likeParams = [];
    for (const t of searchTokens.slice(0, 6)) {
      likeParams.push(`%${t}%`, `%${t}%`);
    }

    if (likeClauses) {
      const [likeRows] = await pool.execute(
        `SELECT id, url, title, content_text, 0 as score
           FROM chatbot_knowledge_pages
          WHERE tenant_id = ? AND chatbot_id = ? AND status = 'INDEXED' AND source_fingerprint = ?
            AND (${likeClauses})
          LIMIT ?`,
        [tenantId, chatbotId, activeFingerprint, ...likeParams, limit],
      );

      for (const r of likeRows) {
        if (!existingIds.has(r.id)) {
          rows.push(r);
          existingIds.add(r.id);
        }
      }
    }
  }

  // Score candidate rows
  return rows
    .map((r) => ({
      ...r,
      finalScore: scoreCandidatePage(r, meaningful, concept),
      targetConcept: concept,
    }))
    .sort((a, b) => b.finalScore - a.finalScore);
}

/**
 * Search relevant knowledge excerpts for a chatbot.
 * Strictly scoped to tenant_id, chatbot_id, and status = 'INDEXED'.
 * INACTIVE pages are strictly excluded from retrieval.
 * Supports:
 * - Multi-concept decomposition and Top-K per concept
 * - Semantic co-occurrence and heading boosts
 * - Excerpt windowing preserving full explanations
 */
export async function searchKnowledgeExcerpts({
  tenantId,
  chatbotId,
  query,
  maxExcerpts = 5,
  maxTotalWords = 2000,
}) {
  // Check active source fingerprint and reconfiguring state
  const [crawlStates] = await pool.execute(
    `SELECT active_source_fingerprint, last_check_status
       FROM chatbot_crawl_states
      WHERE tenant_id = ? AND chatbot_id = ? LIMIT 1`,
    [tenantId, chatbotId],
  );
  const crawlState = crawlStates[0];
  let activeFingerprint = crawlState?.active_source_fingerprint || null;
  const isReconfiguring = crawlState?.last_check_status === "RECONFIGURING";

  // If chatbot is currently reconfiguring, strictly exclude knowledge from retrieval
  if (isReconfiguring) {
    return [];
  }

  // Fallback to most recent indexed page fingerprint ONLY if no crawl state record exists
  if (!activeFingerprint) {
    if (!crawlState) {
      const [pageFps] = await pool.execute(
        `SELECT source_fingerprint FROM chatbot_knowledge_pages
          WHERE tenant_id = ? AND chatbot_id = ? AND status = 'INDEXED' AND source_fingerprint IS NOT NULL
          ORDER BY id DESC LIMIT 1`,
        [tenantId, chatbotId],
      );
      if (pageFps.length > 0) {
        activeFingerprint = pageFps[0].source_fingerprint;
      }
    }
  }

  if (!activeFingerprint) {
    return [];
  }

  const rawQuery = String(query || "").trim();
  const normalizedQuery = rawQuery.toLowerCase();
  const extractedConcepts = extractQueryConcepts(rawQuery);
  const meaningfulTokens = getMeaningfulTokens(rawQuery);

  if (!meaningfulTokens.length) {
    // If no query words, return latest active indexed pages summary
    const [latestRows] = await pool.execute(
      `SELECT id, url, title, content_text
         FROM chatbot_knowledge_pages
        WHERE tenant_id = ? AND chatbot_id = ? AND status = 'INDEXED' AND source_fingerprint = ?
        ORDER BY updated_at DESC
        LIMIT ?`,
      [tenantId, chatbotId, activeFingerprint, maxExcerpts],
    );

    const excerpts = latestRows.map((r) => ({
      id: r.id,
      url: r.url,
      title: r.title,
      text: r.content_text.slice(0, 1000),
    }));
    excerpts.extractedConcepts = extractedConcepts;
    return excerpts;
  }

  let finalCandidatePages = [];

  // =========================================================================
  // MULTI-CONCEPT QUERY RETRIEVAL (Top-K per concept guarantee)
  // =========================================================================
  if (extractedConcepts.length >= 2) {
    const conceptWinners = new Map(); // concept -> array of top pages
    const seenPageIds = new Set();

    for (const concept of extractedConcepts) {
      const cCandidates = await fetchCandidatesForConcept({
        tenantId,
        chatbotId,
        activeFingerprint,
        concept,
        limit: 5,
      });
      conceptWinners.set(concept, cCandidates);
    }

    // Also fetch candidates for the overall compound query
    const overallCandidates = await fetchCandidatesForConcept({
      tenantId,
      chatbotId,
      activeFingerprint,
      concept: rawQuery,
      limit: 6,
    });

    // 1. Guarantee top 1 page per concept first
    for (const concept of extractedConcepts) {
      const list = conceptWinners.get(concept) || [];
      for (const p of list) {
        if (!seenPageIds.has(p.id)) {
          seenPageIds.add(p.id);
          finalCandidatePages.push({ ...p, preferredQuery: concept });
          break; // 1 guaranteed per concept
        }
      }
    }

    // 2. Add top results from compound query
    for (const p of overallCandidates) {
      if (finalCandidatePages.length >= maxExcerpts) break;
      if (!seenPageIds.has(p.id)) {
        seenPageIds.add(p.id);
        finalCandidatePages.push({ ...p, preferredQuery: rawQuery });
      }
    }

    // 3. Add secondary candidates from each concept if slots remain
    for (const concept of extractedConcepts) {
      if (finalCandidatePages.length >= maxExcerpts) break;
      const list = conceptWinners.get(concept) || [];
      for (const p of list) {
        if (!seenPageIds.has(p.id)) {
          seenPageIds.add(p.id);
          finalCandidatePages.push({ ...p, preferredQuery: concept });
          if (finalCandidatePages.length >= maxExcerpts) break;
        }
      }
    }
  } else {
    // =========================================================================
    // SINGLE CONCEPT QUERY RETRIEVAL
    // =========================================================================
    const candidates = await fetchCandidatesForConcept({
      tenantId,
      chatbotId,
      activeFingerprint,
      concept: rawQuery,
      limit: maxExcerpts * 2,
    });
    finalCandidatePages = candidates.slice(0, maxExcerpts).map((p) => ({
      ...p,
      preferredQuery: rawQuery,
    }));
  }

  // =========================================================================
  // EXCERPT EXTRACTION (Window size 1800 chars, total words bounded)
  // =========================================================================
  const excerpts = [];
  let currentWords = 0;

  for (const page of finalCandidatePages) {
    if (excerpts.length >= maxExcerpts) break;

    const pageTextLower = (page.content_text || "").toLowerCase();
    const distinctMatchesInPage = meaningfulTokens.filter((t) => pageTextLower.includes(t));
    const queryForWindow = distinctMatchesInPage.length >= 3 ? rawQuery : (page.preferredQuery || rawQuery);
    const snippet = extractRelevantWindow(page.content_text, queryForWindow, 1800);
    const snippetWords = snippet.split(/\s+/).length;

    if (currentWords + snippetWords > maxTotalWords && excerpts.length > 0) {
      break;
    }

    excerpts.push({
      id: page.id,
      url: page.url,
      title: page.title,
      text: snippet,
      score: page.finalScore || 0,
      matchedConcept: page.targetConcept || null,
    });
    currentWords += snippetWords;
  }

  // =========================================================================
  // RETRIEVAL DEBUGGING (Requirement 9)
  // =========================================================================
  console.log(`[RetrievalDebug] ==========================================`);
  console.log(`[RetrievalDebug] originalQuery: "${rawQuery}"`);
  console.log(`[RetrievalDebug] normalizedQuery: "${normalizedQuery}"`);
  console.log(`[RetrievalDebug] extractedConcepts: ${JSON.stringify(extractedConcepts)}`);
  console.log(`[RetrievalDebug] source_generation_id: ${activeFingerprint}`);
  console.log(
    `[RetrievalDebug] retrievedPages: ${JSON.stringify(
      excerpts.map((e) => ({ id: e.id, title: e.title, score: e.score, concept: e.matchedConcept })),
    )}`,
  );
  console.log(`[RetrievalDebug] ==========================================`);

  excerpts.extractedConcepts = extractedConcepts;
  return excerpts;
}

/**
 * Generates website-specific suggested questions grounded in the chatbot's indexed pages.
 * Associated strictly with (tenantId, chatbotId).
 * Caches in config and does NOT execute during widget rendering.
 */
export async function generateWebsiteSuggestedQuestions({
  tenantId,
  chatbotId,
  pages: providedPages,
  sourceFingerprint,
}) {
  let pages = providedPages;
  if (!pages || !pages.length) {
    let querySql = `SELECT url, title, content_text
         FROM chatbot_knowledge_pages
        WHERE tenant_id = ? AND chatbot_id = ? AND status = 'INDEXED'`;
    const params = [tenantId, chatbotId];
    if (sourceFingerprint) {
      querySql += ` AND source_fingerprint = ?`;
      params.push(sourceFingerprint);
    }
    querySql += ` ORDER BY id ASC LIMIT 6`;
    const [dbPages] = await pool.query(querySql, params);
    pages = dbPages;
  }

  if (!pages || !pages.length) {
    return [];
  }

  const fullCorpus = pages.map((p) => `${p.title || ""} ${p.content_text || ""}`.toLowerCase()).join(" ");

  // 1. Try generating with Gemini if configured
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && apiKey.trim().length > 10) {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: apiKey.trim() });
      const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

      const summaries = pages
        .map((p, idx) => `[Page ${idx + 1}: ${p.title} (${p.url})]\n${(p.content_text || "").slice(0, idx === 0 ? 1500 : 350)}`)
        .join("\n\n");

      const prompt = `Based ONLY on the following indexed website content for this chatbot, generate 3 to 4 concise, high-value suggested questions that a visitor would ask.

CRITICAL RULES:
- Every question must be directly answerable from the provided website content.
- Dynamically detect the website domain/industry (e.g., E-commerce/Products, Healthcare/Clinic, Software/SaaS, Education/University, Business/Company) and generate questions specific to its actual offerings.
- Questions must be natural, concise, and under 65 characters.
- Return ONLY a valid JSON array of strings, for example: ["What services or programs are offered?", "Where is the documentation?", "How do I get started?"] or ["What products are available?", "What is the return policy?"] or ["What departments are in this clinic?", "How do I book an appointment?"].

WEBSITE CONTENT:
${summaries}
`;

      const response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          temperature: 0.2,
          maxOutputTokens: 300,
          responseMimeType: "application/json",
        },
      });

      if (response?.text) {
        const parsed = JSON.parse(response.text);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Validate questions against indexed corpus
          const valid = parsed
            .map((q) => String(q || "").trim())
            .filter((q) => {
              if (q.length < 5 || q.length > 80) return false;
              const words = q.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter((w) => w.length > 3 && !STOPWORDS.has(w));
              return words.some((w) => fullCorpus.includes(w));
            });

          if (valid.length >= 2) {
            return valid.slice(0, 4).map((text, idx) => ({
              id: `question-${Date.now()}-${idx}`,
              text,
            }));
          }
        }
      }
    }
  } catch (aiErr) {
    console.warn("[KnowledgeService] Gemini suggested questions generation error:", aiErr.message);
  }

  // 2. Heuristic fallback from page titles and headings
  const heuristicQuestions = [];
  const homeTitle = pages[0]?.title || "";
  const cleanHomeTitle = homeTitle.split(/[|\-–]/)[0].trim();

  if (cleanHomeTitle) {
    heuristicQuestions.push(`What is ${cleanHomeTitle}?`);
  }

  // E-commerce cues
  if (fullCorpus.includes("product") || fullCorpus.includes("shop") || fullCorpus.includes("catalog")) {
    heuristicQuestions.push("What products or items are available?");
  }
  if (fullCorpus.includes("return") || fullCorpus.includes("shipping") || fullCorpus.includes("delivery")) {
    heuristicQuestions.push("What is the shipping or return policy?");
  }

  // Healthcare / Medical cues
  if (fullCorpus.includes("appointment") || fullCorpus.includes("doctor") || fullCorpus.includes("patient")) {
    heuristicQuestions.push("How can I book an appointment?");
  }
  if (fullCorpus.includes("clinic") || fullCorpus.includes("treatment") || fullCorpus.includes("specialist")) {
    heuristicQuestions.push("What medical services are available?");
  }

  // Education cues
  if (fullCorpus.includes("admission") || fullCorpus.includes("eligibility") || fullCorpus.includes("scholarship")) {
    heuristicQuestions.push("What are the admission and eligibility requirements?");
  }
  if (fullCorpus.includes("course") || fullCorpus.includes("curriculum") || fullCorpus.includes("degree")) {
    heuristicQuestions.push("What courses or programs are offered?");
  }

  // Software / Documentation cues
  if (fullCorpus.includes("documentation") || fullCorpus.includes("docs")) {
    heuristicQuestions.push("Where can I find the official documentation?");
  }
  if (fullCorpus.includes("get started") || fullCorpus.includes("installation") || fullCorpus.includes("install")) {
    heuristicQuestions.push("How do I get started?");
  }
  if (fullCorpus.includes("community") || fullCorpus.includes("forum") || fullCorpus.includes("discord")) {
    heuristicQuestions.push("How can I join the community?");
  }
  if (fullCorpus.includes("features") || fullCorpus.includes("overview")) {
    heuristicQuestions.push("What are the key features?");
  }

  // General contact cue
  if (heuristicQuestions.length < 3 && (fullCorpus.includes("contact") || fullCorpus.includes("support") || fullCorpus.includes("reach us"))) {
    heuristicQuestions.push("How do I contact support?");
  }

  return heuristicQuestions.slice(0, 4).map((text, idx) => ({
    id: `question-${Date.now()}-${idx}`,
    text,
  }));
}

/**
 * Generic current-source topic inventory helper.
 * Derives concise, verified topic follow-up questions strictly from the current active
 * source generation pages for this (tenantId, chatbotId, sourceFingerprint).
 * Never leaks data from previous sources or older generations.
 */
export async function getCurrentSourceTopicInventory({
  tenantId,
  chatbotId,
  sourceFingerprint,
  limit = 3,
}) {
  if (!tenantId || !chatbotId || !sourceFingerprint) {
    return [];
  }

  const [rows] = await pool.query(
    `SELECT id, url, title, SUBSTRING(content_text, 1, 300) as snippet
       FROM chatbot_knowledge_pages
      WHERE tenant_id = ? AND chatbot_id = ? AND source_fingerprint = ? AND status = 'INDEXED'
      ORDER BY id ASC LIMIT 25`,
    [tenantId, chatbotId, sourceFingerprint],
  );

  if (!rows || rows.length === 0) {
    return [];
  }

  const seen = new Set();
  const candidateQuestions = [];

  for (const page of rows) {
    const rawTitle = page.title || "";
    // Clean delimiters like –, -, |, —, ::
    let cleanTitle = rawTitle.split(/[|\-–—:]/)[0].trim();
    if (!cleanTitle || cleanTitle.length < 3 || cleanTitle.length > 50) continue;
    const lower = cleanTitle.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);

    let q;
    if (cleanTitle.endsWith("?")) {
      q = cleanTitle;
    } else if (/^how to|^how do/i.test(cleanTitle)) {
      q = cleanTitle + "?";
    } else if (/components|hooks|versions|apis|features|items|products|services|programs|courses/i.test(cleanTitle)) {
      q = `What are ${cleanTitle}?`;
    } else {
      q = `What is ${cleanTitle}?`;
    }
    candidateQuestions.push(q);
    if (candidateQuestions.length >= limit) break;
  }

  return candidateQuestions.slice(0, limit);
}

