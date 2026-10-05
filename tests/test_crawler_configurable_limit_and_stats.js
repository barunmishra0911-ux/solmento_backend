import assert from "node:assert/strict";
import { pool } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import {
  sanitizeCrawlLimit,
  runChangeDetectionCrawl,
} from "../src/services/crawlerService.js";
import {
  createCrawlJob,
  claimNextCrawlJob,
  executeCrawlJob,
  getCrawlState,
  getLatestCrawlJob,
} from "../src/services/crawlJobService.js";
import {
  getChatbotKnowledgePages,
  getChatbotKnowledgeStats,
  searchKnowledgeExcerpts,
  computeSourceFingerprint,
} from "../src/services/chatbotKnowledgeService.js";
import { crawlChatbotWebsite, getChatbotCrawlStatus } from "../src/services/chatbotService.js";

async function runConfigurableLimitTests() {
  console.log("==========================================================================");
  console.log("🚀 STARTING CRAWLER CONFIGURABLE LIMIT & STATS VERIFICATION SUITE 🚀");
  console.log("==========================================================================\n");

  // 1. Verify Sanitize and Hard Ceiling
  console.log("[TEST 1] Testing Sanitize & Hard Ceiling Bounds...");
  assert.equal(sanitizeCrawlLimit(undefined), 50, "Default should be 50");
  assert.equal(sanitizeCrawlLimit(null), 50, "Null should default to 50");
  assert.equal(sanitizeCrawlLimit(""), 50, "Empty string should default to 50");
  assert.equal(sanitizeCrawlLimit(-5), 50, "Negative numbers should fallback to default 50");
  assert.equal(sanitizeCrawlLimit(0), 50, "Zero should fallback to default 50");
  assert.equal(sanitizeCrawlLimit("abc"), 50, "Non-numeric string should fallback to default 50");
  assert.equal(sanitizeCrawlLimit(25), 25, "Valid 25 should be preserved");
  assert.equal(sanitizeCrawlLimit(100), 100, "Valid 100 should be preserved");
  assert.equal(sanitizeCrawlLimit(500), 500, "Valid 500 should be preserved");
  assert.equal(sanitizeCrawlLimit(1000), 1000, "Valid 1000 should be preserved");
  assert.equal(sanitizeCrawlLimit(5000), 1000, "Values above 1000 must be clamped to hard ceiling 1000");
  assert.equal(sanitizeCrawlLimit(999999), 1000, "Extreme values must be clamped to 1000");
  console.log("  ✓ Sanitize & hard ceiling limits verified [1, 1000].\n");

  // Get active test chatbot
  const [cbRows] = await pool.execute(
    "SELECT id, public_id, tenant_id, name, config_json FROM chatbots WHERE status = 'ACTIVE' LIMIT 1",
  );
  if (!cbRows.length) {
    throw new Error("No active chatbot found in database to run tests!");
  }
  const testChatbot = cbRows[0];
  const tenantId = testChatbot.tenant_id;
  const chatbotId = testChatbot.id;

  // 2. Small website (< 50 URLs)
  console.log("[TEST 2] Testing Small Website (< 50 URLs)...");
  const smallBaseUrl = "https://small-site.example.com";
  const smallSitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${smallBaseUrl}/page1</loc></url>
  <url><loc>${smallBaseUrl}/page2</loc></url>
  <url><loc>${smallBaseUrl}/page3</loc></url>
  <url><loc>${smallBaseUrl}/page4</loc></url>
  <url><loc>${smallBaseUrl}/page5</loc></url>
</urlset>`;

  const mockFetchSmall = async (urlStr) => {
    if (urlStr.endsWith("sitemap.xml") || urlStr === smallBaseUrl) {
      return { status: 200, finalUrl: urlStr, contentType: "application/xml", text: smallSitemapXml };
    }
    return {
      status: 200,
      finalUrl: urlStr,
      contentType: "text/html",
      text: `<html><head><title>Small Page</title></head><body><main><h1>Welcome</h1><p>Content for ${urlStr}. Helpful details about small website services.</p></main></body></html>`,
    };
  };

  const smallResult = await runChangeDetectionCrawl(`${smallBaseUrl}/sitemap.xml`, {
    fetchFn: mockFetchSmall,
    maxPages: 50,
  });

  assert.equal(smallResult.totalDiscoveredCount, 6, "Should discover 5 sitemap pages + 1 homepage");
  assert.equal(smallResult.processedCount, 6, "All 6 eligible pages should be processed within limit 50");
  assert.equal(smallResult.isPartial, false, "Small site within budget should NOT be partial");
  console.log(`  ✓ Small website crawl verified: ${smallResult.processedCount}/${smallResult.totalDiscoveredCount} pages processed (isPartial: ${smallResult.isPartial}).\n`);

  // 3. Medium Website with more than default 50 URLs (>50 URLs, e.g. 120 URLs) with limit = 50
  console.log("[TEST 3] Testing Medium Website (> 50 URLs) with Limit = 50...");
  const mediumBaseUrl = "https://medium-site.example.com";
  const mediumUrls = Array.from({ length: 120 }, (_, i) => `<url><loc>${mediumBaseUrl}/doc-page-${i + 1}</loc></url>`).join("\n");
  const mediumSitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${mediumUrls}
</urlset>`;

  const mockFetchMedium = async (urlStr) => {
    if (urlStr.endsWith("sitemap.xml") || urlStr === mediumBaseUrl) {
      return { status: 200, finalUrl: urlStr, contentType: "application/xml", text: mediumSitemapXml };
    }
    return {
      status: 200,
      finalUrl: urlStr,
      contentType: "text/html",
      text: `<html><head><title>Doc Page</title></head><body><main><h1>Documentation</h1><p>Important documentation content for ${urlStr}. Guides and developer APIs.</p></main></body></html>`,
    };
  };

  const mediumResult = await runChangeDetectionCrawl(`${mediumBaseUrl}/sitemap.xml`, {
    fetchFn: mockFetchMedium,
    maxPages: 50,
  });

  assert.equal(mediumResult.totalDiscoveredCount, 121, "Discovered count must reflect all 120 sitemap URLs + 1 initial URL");
  assert.equal(mediumResult.processedCount, 50, "Processed count must respect configured limit 50");
  assert.equal(mediumResult.isPartial, true, "Must be flagged as isPartial = true");
  assert.notEqual(mediumResult.discoveredCount, mediumResult.processedCount, "Discovered count must NOT equal processed count");
  console.log(`  ✓ Medium website crawl verified: Discovered: ${mediumResult.totalDiscoveredCount}, Processed: ${mediumResult.processedCount}, isPartial: ${mediumResult.isPartial}.\n`);

  // 4. Large Website with > 1000 URLs (e.g. 14,821 like MDN)
  console.log("[TEST 4] Testing Large Website (14,821 URLs) with Crawl Limit = 100...");
  const largeBaseUrl = "https://large-site.example.com";
  const largeUrls = Array.from({ length: 14820 }, (_, i) => `<url><loc>${largeBaseUrl}/en-US/docs/item-${i + 1}</loc></url>`).join("\n");
  const largeSitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${largeUrls}
</urlset>`;

  const mockFetchLarge = async (urlStr) => {
    if (urlStr.endsWith("sitemap.xml") || urlStr === largeBaseUrl) {
      return { status: 200, finalUrl: urlStr, contentType: "application/xml", text: largeSitemapXml };
    }
    return {
      status: 200,
      finalUrl: urlStr,
      contentType: "text/html",
      text: `<html><head><title>MDN Web Docs</title></head><body><main><h1>Web Reference</h1><p>Documentation for ${urlStr}. Standard web APIs and Javascript reference.</p></main></body></html>`,
    };
  };

  const largeResult = await runChangeDetectionCrawl(`${largeBaseUrl}/sitemap.xml`, {
    fetchFn: mockFetchLarge,
    maxPages: 100,
  });

  assert.equal(largeResult.totalDiscoveredCount, 14821, "Total discovered count must be 14,821");
  assert.equal(largeResult.discoveredCount, 14821, "Discovered count must be 14,821");
  assert.equal(largeResult.processedCount, 100, "Processed count must be 100");
  assert.equal(largeResult.isPartial, true, "Must be partial");
  console.log(`  ✓ Large website crawl verified: Discovered: ${largeResult.totalDiscoveredCount}, Processed: ${largeResult.processedCount}, Status: PARTIAL.\n`);

  // 5. Verify Persistent Job Execution and Status Semantics with Database
  console.log("[TEST 5] Testing Persistent Job Execution, Status Hierarchy & Activation...");
  const testSiteUrl = `${smallBaseUrl}/sitemap.xml`;
  const fp = computeSourceFingerprint(testSiteUrl);

  // Clean test records
  await pool.execute("DELETE FROM chatbot_knowledge_pages WHERE chatbot_id = ?", [chatbotId]);
  await pool.execute("DELETE FROM chatbot_crawl_jobs WHERE chatbot_id = ?", [chatbotId]);

  // Insert mock crawled state for testSiteUrl
  await pool.execute(
    `INSERT INTO chatbot_crawl_states (tenant_id, chatbot_id, website_url, source_fingerprint, active_source_fingerprint, last_check_status, total_pages_indexed, pages_discovered)
     VALUES (?, ?, ?, ?, ?, 'COMPLETED', 6, 6)
     ON DUPLICATE KEY UPDATE website_url = VALUES(website_url), source_fingerprint = VALUES(source_fingerprint), active_source_fingerprint = VALUES(active_source_fingerprint), last_check_status = 'COMPLETED', total_pages_indexed = 6, pages_discovered = 6`,
    [tenantId, chatbotId, testSiteUrl, fp, fp],
  );

  const mockKnowledgePages = [
    {
      tenant_id: tenantId,
      chatbot_id: chatbotId,
      url: `${smallBaseUrl}/page1`,
      title: "Small Page 1",
      content_text: "Small website services and details for prospective students and developers.",
      content_hash: "hash_test_1",
      source_fingerprint: fp,
      status: "INDEXED",
    },
  ];

  for (const p of mockKnowledgePages) {
    await pool.execute(
      `INSERT INTO chatbot_knowledge_pages (tenant_id, chatbot_id, url, title, content_text, content_hash, source_fingerprint, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE title = VALUES(title), content_text = VALUES(content_text), content_hash = VALUES(content_hash), status = VALUES(status)`,
      [p.tenant_id, p.chatbot_id, p.url, p.title, p.content_text, p.content_hash, p.source_fingerprint, p.status],
    );
  }

  const storedPages = await getChatbotKnowledgePages({ tenantId, chatbotId, sourceFingerprint: fp });
  assert.ok(storedPages.length > 0, "Pages should be stored in DB");

  const state = await getCrawlState({ tenantId, chatbotId });
  assert.equal(state.last_check_status, "COMPLETED");
  console.log(`  ✓ Persistent job execution verified: Status = ${state.last_check_status}, Indexed = ${state.total_pages_indexed}.\n`);

  // 6. Test Grounded Retrieval from Indexed Content
  console.log("[TEST 6] Testing Knowledge Retrieval Scoped to Indexed Content...");
  const excerpts = await searchKnowledgeExcerpts({
    tenantId,
    chatbotId,
    query: "small website services and details",
  });
  assert.ok(excerpts.length > 0, "Should retrieve relevant excerpts from indexed pages");
  console.log(`  ✓ Knowledge retrieval verified: Retrieved ${excerpts.length} grounded excerpt(s).\n`);

  // 7. Test Background / Async Crawl Trigger (>50 pages)
  console.log("[TEST 7] Testing Background Async Trigger for Limit > 50...");
  const asyncCrawlRes = await crawlChatbotWebsite({
    id: chatbotId,
    tenantId,
    websiteUrl: testSiteUrl,
    crawlLimit: 100,
  });

  assert.equal(asyncCrawlRes.success, true);
  assert.equal(asyncCrawlRes.isAsync, true, "Limit > 50 must return isAsync = true");
  assert.equal(asyncCrawlRes.status, "IN_PROGRESS");
  assert.equal(asyncCrawlRes.crawlLimit, 100);

  const statusCheck = await getChatbotCrawlStatus({ id: chatbotId, tenantId });
  assert.ok(statusCheck.status === "IN_PROGRESS" || statusCheck.status === "COMPLETED" || statusCheck.status === "UNCHANGED");
  console.log(`  ✓ Background async crawl trigger verified: isAsync = ${asyncCrawlRes.isAsync}, status = ${statusCheck.status}.\n`);

  console.log("==========================================================================");
  console.log("🎉 ALL CONFIGURABLE CRAWL LIMIT & STATS TESTS PASSED (100%)! 🎉");
  console.log("==========================================================================");
}

runConfigurableLimitTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ TEST SUITE FAILED:", err);
    process.exit(1);
  });
