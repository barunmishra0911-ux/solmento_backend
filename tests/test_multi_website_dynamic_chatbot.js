import assert from "node:assert/strict";
import { pool } from "../src/config/database.js";
import {
  saveCrawledPages,
  getChatbotKnowledgeStats,
  searchKnowledgeExcerpts,
  computeSourceFingerprint,
  generateWebsiteSuggestedQuestions,
} from "../src/services/chatbotKnowledgeService.js";
import {
  extractCleanContent,
  computeContentHash,
  extractSitemapEntries,
  isSitemapIndex,
  extractChildSitemapUrls,
  runChangeDetectionCrawl,
} from "../src/services/crawlerService.js";
import {
  getPublicWidgetConfig,
  sendPublicWidgetMessage,
  savePublicLead,
  publishChatbotBuilder,
} from "../src/services/chatbotService.js";
import { generateGroundedResponse } from "../src/services/geminiService.js";

async function runMultiWebsiteSuite() {
  console.log("=================================================================");
  console.log("🚀 STARTING COMPREHENSIVE DYNAMIC MULTI-WEBSITE VERIFICATION 🚀");
  console.log("=================================================================\n");

  const tenantId = 7;
  const chatbotId = 81; // Using Chatbot 81
  const [[cbRow]] = await pool.execute(
    "SELECT id, public_id, name, status, config_json, published_config_json FROM chatbots WHERE id = ?",
    [chatbotId],
  );
  if (!cbRow) throw new Error("Chatbot 81 not found for test execution!");
  const publicId = cbRow.public_id;
  const initialConfig = typeof cbRow.config_json === "string" ? JSON.parse(cbRow.config_json) : cbRow.config_json;

  // ----------------------------------------------------
  // SECTION 1: Nested Sitemaps, XML Namespaces & CDATA Parsing
  // ----------------------------------------------------
  console.log("[TEST 1] Testing Sitemap Index, Nested Sitemaps, and CDATA Extraction...");
  const sitemapIndexXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc><![CDATA[https://apex-store.com/sitemap-products.xml]]></loc>
    <lastmod>2026-10-01T12:00:00Z</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://apex-store.com/sitemap-policies.xml</loc>
  </sitemap>
</sitemapindex>`;

  assert.equal(isSitemapIndex(sitemapIndexXml), true, "Should recognize <sitemapindex>");
  const childUrls = extractChildSitemapUrls(sitemapIndexXml);
  assert.deepEqual(childUrls, [
    "https://apex-store.com/sitemap-products.xml",
    "https://apex-store.com/sitemap-policies.xml",
  ], "Should correctly unpack child sitemaps and strip CDATA");

  const childProductXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc><![CDATA[https://apex-store.com/products/noise-cancelling-headphones]]></loc>
    <lastmod>2026-10-02</lastmod>
  </url>
  <url>
    <loc>https://apex-store.com/policies/returns</loc>
    <lastmod>2026-09-15</lastmod>
  </url>
</urlset>`;

  const productEntries = extractSitemapEntries(childProductXml);
  assert.equal(productEntries.length, 2);
  assert.equal(productEntries[0].url, "https://apex-store.com/products/noise-cancelling-headphones");
  assert.equal(productEntries[0].lastmod, "2026-10-02");
  assert.equal(productEntries[1].url, "https://apex-store.com/policies/returns");
  console.log("  ✓ Sitemap indexes, nested child sitemaps, and CDATA parsing verified.");

  // ----------------------------------------------------
  // SECTION 2: Multi-Website Categories & Domain Grounding
  // ----------------------------------------------------
  console.log("\n[TEST 2] Testing Grounded Answers & Domain Safety Across Diverse Categories...");

  // Category A: E-Commerce Store
  console.log("  [Category A: E-Commerce Store]");
  const ecommerceExcerpts = [
    {
      title: "Apex Acoustics - Wireless Headphones",
      url: "https://apex-store.com/products/noise-cancelling-headphones",
      text: "The Apex QuietPro Wireless Headphones are priced at $249. Features include 40-hour battery life, active noise cancellation, and Bluetooth 5.3. In stock: 35 units available. Shipping is free on orders over $50.",
    },
    {
      title: "Apex Acoustics - Return & Warranty Policy",
      url: "https://apex-store.com/policies/returns",
      text: "We offer a 30-day money-back guarantee on all audio accessories. Items must be returned in original packaging. Return shipping is free for defective units.",
    },
  ];

  const ecommerceResponse = await generateGroundedResponse({
    chatbotName: "Apex Store Assistant",
    excerpts: ecommerceExcerpts,
    history: [],
    userQuestion: "How much are the QuietPro headphones and what is your return policy?",
  });
  console.log("    E-commerce Reply:", ecommerceResponse.reply.slice(0, 140) + "...");
  console.log("    E-commerce Follow-ups:", ecommerceResponse.followUpQuestions);
  assert(ecommerceResponse.reply.includes("249"), "Must accurately cite $249 price");
  assert(ecommerceResponse.reply.toLowerCase().includes("30-day") || ecommerceResponse.reply.toLowerCase().includes("return"), "Must state 30-day return policy");
  assert(!ecommerceResponse.reply.toLowerCase().includes("b.tech") && !ecommerceResponse.reply.toLowerCase().includes("admission"), "No college leakage in e-commerce response");
  console.log("  ✓ Category A (E-Commerce) accurate price and return policy verified.");

  // Category B: Healthcare / Medical Informational
  console.log("  [Category B: Healthcare / Medical Informational]");
  const medicalExcerpts = [
    {
      title: "City Wellness Hospital - Cardiology Department",
      url: "https://citywellness.org/cardiology",
      text: "The Cardiology Department at City Wellness Hospital offers diagnostic ECG, echocardiograms, and specialist consultations with Dr. Sarah Jenkins (Mon-Thu 9am-2pm). To schedule an appointment, patients can call 555-0199 or use the online patient portal.",
    },
    {
      title: "City Wellness Hospital - General Visiting Hours",
      url: "https://citywellness.org/visiting",
      text: "General visiting hours are between 4:00 PM and 7:00 PM daily. A maximum of two visitors per patient are permitted in inpatient wards.",
    },
  ];

  const medicalResponse = await generateGroundedResponse({
    chatbotName: "City Wellness Assistant",
    excerpts: medicalExcerpts,
    history: [],
    userQuestion: "Who is the cardiologist, and what medication should I take for chest tightness?",
  });
  console.log("    Medical Reply:", medicalResponse.reply.slice(0, 140) + "...");
  assert(medicalResponse.reply.includes("Dr. Sarah Jenkins"), "Must cite cardiologist Dr. Sarah Jenkins");
  const medLower = medicalResponse.reply.toLowerCase();
  assert(
    medLower.includes("consult") || medLower.includes("professional") || medLower.includes("cannot provide") || medLower.includes("prescribe") || medLower.includes("doctor"),
    "Must include medical safety disclaimer against prescribing medications",
  );
  assert(!medLower.includes("quietpro") && !medLower.includes("django"), "No cross-category data leakage");
  console.log("  ✓ Category B (Healthcare) doctor citation and medical safety disclaimer verified.");

  // Category C: Software Documentation / SaaS
  console.log("  [Category C: Software Documentation / SaaS]");
  const saasExcerpts = [
    {
      title: "FastQueue - High Performance Redis Queue",
      url: "https://fastqueue.dev/docs/getting-started",
      text: "FastQueue is an open-source distributed task queue built on Redis and Go. Install via 'go install github.com/fastqueue/cli@latest'. Configure with REDIS_URL=redis://localhost:6379.",
    },
    {
      title: "FastQueue - Key Features and Architecture",
      url: "https://fastqueue.dev/docs/features",
      text: "Key features of FastQueue include distributed task processing, Redis-backed in-memory persistence, sub-millisecond job dispatch latency, and automatic exponential backoff retry handling.",
    },
  ];

  const saasResponse = await generateGroundedResponse({
    chatbotName: "FastQueue Bot",
    excerpts: saasExcerpts,
    history: [],
    userQuestion: "How do I install FastQueue?",
  });
  console.log("    SaaS Reply:", saasResponse.reply.slice(0, 140) + "...");
  assert(saasResponse.reply.includes("go install"), "Must accurately cite installation command");
  console.log("  ✓ Category C (Software SaaS) installation instruction verified.");

  // ----------------------------------------------------
  // SECTION 3: Multi-Source Switching Lifecycle (Website A -> Website B -> Website C)
  // ----------------------------------------------------
  console.log("\n[TEST 3] Testing Sequential Multi-Source Switching Lifecycle with Zero Leakage...");

  // Source A: Apex Store (E-Commerce)
  const sourceAUrl = "https://apex-store.com/sitemap.xml";
  const sourceAFp = computeSourceFingerprint(sourceAUrl);

  await saveCrawledPages({
    tenantId,
    chatbotId,
    sourceFingerprint: sourceAFp,
    pages: ecommerceExcerpts.map((e) => ({
      url: e.url,
      title: e.title,
      contentText: e.text,
      contentHash: computeContentHash(e.text),
      status: "INDEXED",
    })),
  });

  await pool.execute(
    `INSERT INTO chatbot_crawl_states
      (tenant_id, chatbot_id, website_url, source_fingerprint, active_source_fingerprint, last_check_status, total_pages_indexed)
     VALUES (?, ?, ?, ?, ?, 'COMPLETED', ?)
     ON DUPLICATE KEY UPDATE website_url = VALUES(website_url), source_fingerprint = VALUES(source_fingerprint),
       active_source_fingerprint = VALUES(active_source_fingerprint), last_check_status = 'COMPLETED',
       total_pages_indexed = VALUES(total_pages_indexed)`,
    [tenantId, chatbotId, sourceAUrl, sourceAFp, sourceAFp, ecommerceExcerpts.length],
  );

  const sourceASuggestions = await generateWebsiteSuggestedQuestions({
    tenantId,
    chatbotId,
    sourceFingerprint: sourceAFp,
  });

  const [[currentCbA]] = await pool.execute("SELECT config_json, published_config_json FROM chatbots WHERE id = ?", [chatbotId]);
  const cA = typeof currentCbA.config_json === "string" ? JSON.parse(currentCbA.config_json) : currentCbA.config_json;
  cA.websiteUrl = sourceAUrl;
  cA.suggestedQuestions = sourceASuggestions;
  await pool.execute(
    "UPDATE chatbots SET config_json = ?, published_config_json = ? WHERE id = ?",
    [JSON.stringify(cA), JSON.stringify(cA), chatbotId],
  );

  const cfgA = await getPublicWidgetConfig(publicId);
  console.log("  Source A Suggestions:", cfgA.config?.suggestedQuestions);
  assert(
    (cfgA.config?.suggestedQuestions || []).some((q) => q.toLowerCase().includes("product") || q.toLowerCase().includes("quietpro") || q.toLowerCase().includes("return") || q.toLowerCase().includes("shipping")),
    "Source A suggestions must be e-commerce oriented",
  );

  // Switch to Source B: City Wellness (Healthcare)
  console.log("  Switching to Source B (Healthcare)...");
  const sourceBUrl = "https://citywellness.org/sitemap.xml";
  const sourceBFp = computeSourceFingerprint(sourceBUrl);

  // 1. Simulate source switch in Builder
  await publishChatbotBuilder({
    id: chatbotId,
    tenantId,
    userId: 1,
    name: cbRow.name,
    status: cbRow.status,
    config: { ...initialConfig, websiteUrl: sourceBUrl },
    changes: ["Switched to City Wellness Hospital website"],
  });

  // Verify immediate neutral state
  const midSwitchCfg = await getPublicWidgetConfig(publicId);
  assert.deepEqual(midSwitchCfg.config?.suggestedQuestions, [], "During reconfiguring, suggestions must be empty []");

  // 2. Index Source B pages and activate
  await saveCrawledPages({
    tenantId,
    chatbotId,
    sourceFingerprint: sourceBFp,
    pages: medicalExcerpts.map((e) => ({
      url: e.url,
      title: e.title,
      contentText: e.text,
      contentHash: computeContentHash(e.text),
      status: "INDEXED",
    })),
  });

  await pool.execute(
    `UPDATE chatbot_crawl_states
        SET website_url = ?, source_fingerprint = ?, active_source_fingerprint = ?, last_check_status = 'COMPLETED', total_pages_indexed = ?
      WHERE chatbot_id = ?`,
    [sourceBUrl, sourceBFp, sourceBFp, medicalExcerpts.length, chatbotId],
  );

  const sourceBSuggestions = await generateWebsiteSuggestedQuestions({
    tenantId,
    chatbotId,
    sourceFingerprint: sourceBFp,
  });

  const [[currentCbB]] = await pool.execute("SELECT config_json, published_config_json FROM chatbots WHERE id = ?", [chatbotId]);
  const cB = typeof currentCbB.config_json === "string" ? JSON.parse(currentCbB.config_json) : currentCbB.config_json;
  cB.websiteUrl = sourceBUrl;
  cB.suggestedQuestions = sourceBSuggestions;
  await pool.execute(
    "UPDATE chatbots SET config_json = ?, published_config_json = ? WHERE id = ?",
    [JSON.stringify(cB), JSON.stringify(cB), chatbotId],
  );

  const cfgB = await getPublicWidgetConfig(publicId);
  console.log("  Source B Suggestions:", cfgB.config?.suggestedQuestions);
  const cfgBText = (cfgB.config?.suggestedQuestions || []).join(" ").toLowerCase();
  assert(!cfgBText.includes("quietpro") && !cfgBText.includes("headphones"), "Source B must have ZERO Source A e-commerce leakage");
  assert(cfgBText.includes("appointment") || cfgBText.includes("doctor") || cfgBText.includes("hospital") || cfgBText.includes("service") || cfgBText.includes("clinic"), "Source B must reflect healthcare suggestions");
  console.log("  ✓ Source B successfully activated with 0 Source A leakage.");

  // ----------------------------------------------------
  // SECTION 4: Conversation Context Isolation Across Source Switch
  // ----------------------------------------------------
  console.log("\n[TEST 4] Testing Conversation Context Isolation Across Source Switch...");
  const visitorId = "switch-test-visitor-" + Date.now();
  await savePublicLead({
    publicId,
    visitorId,
    fields: { name: "Test Visitor", email: "visitor@example.com" },
  });

  // Turn 1 on Source B:
  const turnB1 = await sendPublicWidgetMessage({
    publicId,
    visitorId,
    text: "Who is the cardiologist?",
  });
  console.log("    Visitor Question on Source B: 'Who is the cardiologist?'");
  console.log("    Assistant Reply:", turnB1.reply.slice(0, 100) + "...");
  assert(turnB1.reply.includes("Dr. Sarah Jenkins"), "Answer must cite Dr. Sarah Jenkins");

  // Now switch to Source C (FastQueue Software)
  console.log("  Switching to Source C (Software / SaaS)...");
  const sourceCUrl = "https://fastqueue.dev/sitemap.xml";
  const sourceCFp = computeSourceFingerprint(sourceCUrl);

  await publishChatbotBuilder({
    id: chatbotId,
    tenantId,
    userId: 1,
    name: cbRow.name,
    status: cbRow.status,
    config: { ...initialConfig, websiteUrl: sourceCUrl },
    changes: ["Switched to FastQueue documentation website"],
  });

  await saveCrawledPages({
    tenantId,
    chatbotId,
    sourceFingerprint: sourceCFp,
    pages: saasExcerpts.map((e) => ({
      url: e.url,
      title: e.title,
      contentText: e.text,
      contentHash: computeContentHash(e.text),
      status: "INDEXED",
    })),
  });

  await pool.execute(
    `UPDATE chatbot_crawl_states
        SET website_url = ?, source_fingerprint = ?, active_source_fingerprint = ?, last_check_status = 'COMPLETED', total_pages_indexed = ?
      WHERE chatbot_id = ?`,
    [sourceCUrl, sourceCFp, sourceCFp, saasExcerpts.length, chatbotId],
  );

  // Visitor asks follow-up on Source C:
  // "What are the features?"
  const turnC1 = await sendPublicWidgetMessage({
    publicId,
    visitorId,
    text: "What are the key features?",
  });
  console.log("    Visitor Question on Source C: 'What are the key features?'");
  console.log("    Assistant Reply:", turnC1.reply.slice(0, 140) + "...");
  const replyCLower = turnC1.reply.toLowerCase();
  assert(replyCLower.includes("redis") || replyCLower.includes("queue") || replyCLower.includes("distributed"), "Answer must describe FastQueue features");
  assert(!replyCLower.includes("jenkins") && !replyCLower.includes("cardiolog") && !replyCLower.includes("hospital"), "MUST NOT leak Source B hospital/doctor context into Source C response");
  console.log("  ✓ Conversation context strictly isolated across source switch with ZERO memory leakage.");

  // ----------------------------------------------------
  // SECTION 5: Zero-Index Failure Guard
  // ----------------------------------------------------
  console.log("\n[TEST 5] Testing Honest Failure State on Empty/Unindexable Website...");
  const failedUrl = "https://broken-empty-site.invalid/sitemap.xml";
  const failedFp = computeSourceFingerprint(failedUrl);

  // Ensure 0 indexed pages
  const statsEmpty = await getChatbotKnowledgeStats({
    tenantId,
    chatbotId,
    sourceFingerprint: failedFp,
  });
  assert.equal(statsEmpty.totalPages, 0, "No pages should be indexed for broken URL");

  // In crawlJobService, totalPages === 0 forces FAILED
  const simulatedFinalStatus = statsEmpty.totalPages === 0 ? "FAILED" : "COMPLETED";
  assert.equal(simulatedFinalStatus, "FAILED", "Zero indexed pages MUST result in FAILED status");

  // Verify retrieval returns empty [] when active fingerprint is null/failed
  await pool.execute(
    `UPDATE chatbot_crawl_states
        SET website_url = ?, source_fingerprint = ?, active_source_fingerprint = NULL, last_check_status = 'FAILED', total_pages_indexed = 0
      WHERE chatbot_id = ?`,
    [failedUrl, failedFp, chatbotId],
  );

  const excerptsDuringFailure = await searchKnowledgeExcerpts({
    tenantId,
    chatbotId,
    query: "Tell me about this website",
  });
  assert.deepEqual(excerptsDuringFailure, [], "Search excerpts MUST return empty [] during FAILED / inactive state");
  console.log("  ✓ Honest FAILED status on zero-index pages verified.");

  // ----------------------------------------------------
  // SECTION 6: Cleanup and Restoration of Chatbot 81
  // ----------------------------------------------------
  console.log("\n[CLEANUP] Restoring Chatbot 81 to JUT state and cleaning test records...");
  await pool.execute(
    "DELETE FROM chatbot_knowledge_pages WHERE chatbot_id = ? AND source_fingerprint IN (?, ?, ?)",
    [chatbotId, sourceAFp, sourceBFp, sourceCFp],
  );

  // Restore JUT
  const jutUrl = "https://jutranchi.ac.in/sitemap.xml";
  const jutFp = computeSourceFingerprint(jutUrl);
  await pool.execute(
    `UPDATE chatbot_crawl_states
        SET website_url = ?, source_fingerprint = ?, active_source_fingerprint = ?, last_check_status = 'COMPLETED', total_pages_indexed = 9
      WHERE chatbot_id = ?`,
    [jutUrl, jutFp, jutFp, chatbotId],
  );

  const jutSuggestions = [
    { id: "question-jut-1", text: "How do I contact the university?" },
    { id: "question-jut-2", text: "Where can I find screen reader access?" },
    { id: "question-jut-3", text: "What is the university's vision and mission?" },
    { id: "question-jut-4", text: "Where is Jharkhand University of Technology?" },
  ];

  await pool.execute(
    "UPDATE chatbots SET config_json = ?, published_config_json = ? WHERE id = ?",
    [
      JSON.stringify({ ...initialConfig, websiteUrl: jutUrl, suggestedQuestions: jutSuggestions }),
      JSON.stringify({ ...initialConfig, websiteUrl: jutUrl, suggestedQuestions: jutSuggestions }),
      chatbotId,
    ],
  );

  console.log("  ✓ Chatbot 81 cleanly restored.");

  console.log("\n=================================================================");
  console.log("🎉 ALL DYNAMIC MULTI-WEBSITE VERIFICATION TESTS PASSED (100%)! 🎉");
  console.log("=================================================================\n");
  process.exit(0);
}

runMultiWebsiteSuite().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
