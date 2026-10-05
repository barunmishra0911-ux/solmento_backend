import assert from "node:assert/strict";
import { pool } from "../src/config/database.js";
import {
  validateSafeUrl,
  extractCleanContent,
  computeContentHash,
  extractSitemapEntries,
  computeSitemapHash,
  runChangeDetectionCrawl,
} from "../src/services/crawlerService.js";
import {
  getChatbotKnowledgePages,
  applyCrawlUpdates,
  getChatbotKnowledgeStats,
  searchKnowledgeExcerpts,
  computeSourceFingerprint,
} from "../src/services/chatbotKnowledgeService.js";
import {
  getOrCreateCrawlState,
  getCrawlState,
  createCrawlJob,
  claimNextCrawlJob,
  executeCrawlJob,
  cleanupOldCrawlJobs,
} from "../src/services/crawlJobService.js";
import { scheduleDueChatbots } from "../src/services/crawlSchedulerService.js";
import { generateGroundedResponse, isGeminiConfigured } from "../src/services/geminiService.js";
import { sendPublicWidgetMessage, crawlChatbotWebsite } from "../src/services/chatbotService.js";

async function runPhase2Tests() {
  console.log("=================================================================");
  console.log("🚀 STARTING PHASE 2 CHANGE DETECTION & SCHEDULER VERIFICATION 🚀");
  console.log("=================================================================\n");

  // Get active test chatbot from database
  const [cbRows] = await pool.execute(
    "SELECT id, public_id, tenant_id, name, config_json FROM chatbots WHERE status = 'ACTIVE' LIMIT 1",
  );
  if (!cbRows.length) {
    throw new Error("No active chatbot found in database to run tests!");
  }
  const testChatbot = cbRows[0];
  const tenantId = testChatbot.tenant_id;
  const chatbotId = testChatbot.id;
  console.log(`Using Test Chatbot: "${testChatbot.name}" (ID: ${chatbotId}, Tenant: ${tenantId})`);

  const page1Url = "https://example.edu/admissions/btech-ai";
  const page2Url = "https://example.edu/admissions/hostel";
  const page3Url = "https://example.edu/admissions/scholarships";

  const sourceFingerprint = computeSourceFingerprint(page1Url);

  // Clean up any previous test records for these URLs
  await pool.execute(
    "DELETE FROM chatbot_knowledge_pages WHERE chatbot_id = ? AND url IN (?, ?, ?)",
    [chatbotId, page1Url, page2Url, page3Url],
  );
  await pool.execute(
    "DELETE FROM chatbot_crawl_jobs WHERE chatbot_id = ? AND dedup_key LIKE 'test_%'",
    [chatbotId],
  );
  await pool.execute(
    `INSERT INTO chatbot_crawl_states (tenant_id, chatbot_id, website_url, source_fingerprint, active_source_fingerprint, last_check_status)
     VALUES (?, ?, ?, ?, ?, 'COMPLETED')
     ON DUPLICATE KEY UPDATE website_url = VALUES(website_url), source_fingerprint = VALUES(source_fingerprint), active_source_fingerprint = VALUES(active_source_fingerprint), last_check_status = 'COMPLETED'`,
    [tenantId, chatbotId, page1Url, sourceFingerprint, sourceFingerprint],
  );

  // -----------------------------------------------------------------
  // TEST 1: Initial Crawl & Storage (Acceptance 1, 10)
  // -----------------------------------------------------------------
  console.log("\n[TEST 1] Testing Initial Page Crawl & Storage...");
  const initialContent = "The tuition fee for B.Tech in Artificial Intelligence is INR 2,20,000 per academic year. Eligibility requires 60% in PCM.";
  const initialHash = computeContentHash(initialContent);

  const testPages = [
    {
      url: page1Url,
      title: "B.Tech in Artificial Intelligence",
      contentText: initialContent,
      contentHash: initialHash,
      etag: '"v1-hash-123"',
      lastModified: "Wed, 01 Oct 2026 10:00:00 GMT",
      status: "INDEXED",
    },
  ];

  await applyCrawlUpdates({
    tenantId,
    chatbotId,
    updates: { newPages: testPages },
  });

  const storedPagesAfterTest1 = await getChatbotKnowledgePages({ tenantId, chatbotId });
  const storedPage1 = storedPagesAfterTest1.find((p) => p.url === page1Url);
  assert.ok(storedPage1, "Page 1 should be stored in database");
  assert.equal(storedPage1.content_hash, initialHash, "Content hash should match initial text");
  assert.equal(storedPage1.etag, '"v1-hash-123"', "ETag should be stored");
  assert.equal(storedPage1.status, "INDEXED", "Status should be INDEXED");
  console.log("  ✓ Initial page stored successfully with hash and ETag validators.");

  // -----------------------------------------------------------------
  // TEST 2: HTTP 304 Not Modified Validator (Acceptance 6, 8)
  // -----------------------------------------------------------------
  console.log("\n[TEST 2] Testing HTTP 304 Not Modified Validator...");
  // Simulated fetcher that returns 304 when matching ETag is provided
  const mockFetch304 = async (urlStr, opts) => {
    if (opts.headers?.["If-None-Match"] === '"v1-hash-123"') {
      return { notModified: true, status: 304, finalUrl: urlStr };
    }
    throw new Error("Unexpected request");
  };

  const crawlRes304 = await runChangeDetectionCrawl(page1Url, {
    existingPages: [storedPage1],
    fetchFn: mockFetch304,
    maxPages: 1,
  });

  assert.equal(crawlRes304.unchangedPages.length, 1, "Page 1 should be detected as unchanged via 304");
  assert.equal(crawlRes304.unchangedPages[0].reason, "HTTP_304_NOT_MODIFIED");
  assert.equal(crawlRes304.changedPages.length, 0, "No pages should be marked changed");
  assert.equal(crawlRes304.newPages.length, 0, "No new pages should be created");

  const prevUpdatedAt = storedPage1.updated_at;
  await applyCrawlUpdates({
    tenantId,
    chatbotId,
    updates: { unchangedPages: crawlRes304.unchangedPages },
  });

  const storedAfter304 = (await getChatbotKnowledgePages({ tenantId, chatbotId })).find((p) => p.url === page1Url);
  assert.equal(storedAfter304.content_text, initialContent, "Content text must remain untouched");
  assert.ok(storedAfter304.last_checked_at, "last_checked_at should be updated");
  console.log("  ✓ HTTP 304 correctly handled: Body download skipped, content untouched, no re-indexing.");

  // -----------------------------------------------------------------
  // TEST 3: Normalized Content Hash Fallback (Acceptance 5, 7, 8)
  // -----------------------------------------------------------------
  console.log("\n[TEST 3] Testing Normalized Content Hash Fallback (Missing/Ignored Validators)...");
  // Server returns 200 OK without validator, but content text is identical
  const mockFetchIdentical = async (urlStr) => {
    return {
      status: 200,
      finalUrl: urlStr,
      contentType: "text/html",
      text: `<html><body><main><p>${initialContent}</p></main></body></html>`,
    };
  };

  const crawlResIdentical = await runChangeDetectionCrawl(page1Url, {
    existingPages: [storedAfter304],
    fetchFn: mockFetchIdentical,
    maxPages: 1,
  });

  assert.equal(crawlResIdentical.unchangedPages.length, 1, "Page should be detected as unchanged via content hash");
  assert.equal(crawlResIdentical.unchangedPages[0].reason, "CONTENT_HASH_MATCH");
  assert.equal(crawlResIdentical.changedPages.length, 0, "No changed pages");
  console.log("  ✓ Hash comparison fallback succeeded: Identical content detected, duplicate re-indexing skipped.");

  // -----------------------------------------------------------------
  // TEST 4: Changed Page Detection & Retrieval Update (Acceptance 9, 20)
  // -----------------------------------------------------------------
  console.log("\n[TEST 4] Testing Changed Page Detection & Knowledge Retrieval Update...");
  const updatedFeeContent = "The tuition fee for B.Tech in Artificial Intelligence has been revised to INR 2,50,000 per academic year for 2026. Includes lab equipment.";
  const mockFetchChanged = async (urlStr) => {
    return {
      status: 200,
      finalUrl: urlStr,
      contentType: "text/html",
      etag: '"v2-revised-456"',
      lastModified: "Fri, 03 Oct 2026 09:00:00 GMT",
      text: `<html><head><title>B.Tech AI Revised Fees</title></head><body><main><p>${updatedFeeContent}</p></main></body></html>`,
    };
  };

  const crawlResChanged = await runChangeDetectionCrawl(page1Url, {
    existingPages: [storedAfter304],
    fetchFn: mockFetchChanged,
    maxPages: 1,
  });

  assert.equal(crawlResChanged.changedPages.length, 1, "Page 1 should be detected as changed");
  assert.equal(crawlResChanged.unchangedPages.length, 0);

  await applyCrawlUpdates({
    tenantId,
    chatbotId,
    updates: { changedPages: crawlResChanged.changedPages },
  });

  const storedAfterChange = (await getChatbotKnowledgePages({ tenantId, chatbotId })).find((p) => p.url === page1Url);
  assert.equal(storedAfterChange.content_hash, crawlResChanged.changedPages[0].contentHash);
  assert.equal(storedAfterChange.etag, '"v2-revised-456"');

  // Verify FULLTEXT retrieval returns the new fee
  const excerpts = await searchKnowledgeExcerpts({
    tenantId,
    chatbotId,
    query: "tuition fee for B.Tech in Artificial Intelligence",
  });
  assert.ok(excerpts.length > 0, "Should retrieve excerpt for changed query");
  assert.ok(excerpts[0].text.includes("INR 2,50,000"), "Excerpt must contain newly revised fee amount INR 2,50,000");
  console.log("  ✓ Changed page correctly updated in DB and immediately searchable via FULLTEXT.");

  // -----------------------------------------------------------------
  // TEST 5: Confirmed Removed Page Deactivation (Acceptance 11)
  // -----------------------------------------------------------------
  console.log("\n[TEST 5] Testing Confirmed Removed Page Deactivation (HTTP 404)...");
  const mockFetch404 = async (urlStr) => {
    return { notFound: true, status: 404, finalUrl: urlStr };
  };

  const crawlRes404 = await runChangeDetectionCrawl(page1Url, {
    existingPages: [storedAfterChange],
    fetchFn: mockFetch404,
    maxPages: 1,
  });

  assert.equal(crawlRes404.removedPages.length, 1, "Page should be detected as removed on 404");
  await applyCrawlUpdates({
    tenantId,
    chatbotId,
    updates: { removedPages: crawlRes404.removedPages },
  });

  const storedAfter404 = (await getChatbotKnowledgePages({ tenantId, chatbotId })).find((p) => p.url === page1Url);
  assert.equal(storedAfter404.status, "INACTIVE", "Status must become INACTIVE");
  assert.ok(storedAfter404.content_text.includes("2,50,000"), "Historical content must be preserved, not wiped!");

  // Verify INACTIVE page is completely excluded from search
  const excerptsAfterRemoval = await searchKnowledgeExcerpts({
    tenantId,
    chatbotId,
    query: "Artificial Intelligence",
  });
  const foundInactive = excerptsAfterRemoval.some((e) => e.url === page1Url);
  assert.equal(foundInactive, false, "INACTIVE page must be excluded from search retrieval!");
  console.log("  ✓ Confirmed removed page marked INACTIVE, content preserved, excluded from search.");

  // Reactivate page 1 for subsequent tests
  await pool.execute(
    "UPDATE chatbot_knowledge_pages SET status = 'INDEXED' WHERE id = ?",
    [storedAfter404.id],
  );

  // -----------------------------------------------------------------
  // TEST 6: Transient Error Preservation (Acceptance 12, 13, 14)
  // -----------------------------------------------------------------
  console.log("\n[TEST 6] Testing Transient Error Resilience (HTTP 500 / Network Timeout)...");
  const mockFetch500 = async () => {
    throw new Error("HTTP 503 Service Unavailable");
  };

  const crawlRes500 = await runChangeDetectionCrawl(page1Url, {
    existingPages: [storedAfter404],
    fetchFn: mockFetch500,
    maxPages: 1,
  });

  assert.equal(crawlRes500.failedPages.length, 1, "Transient error recorded as failed page");
  assert.equal(crawlRes500.removedPages.length, 0, "Transient error MUST NOT mark page as removed!");
  assert.equal(crawlRes500.changedPages.length, 0, "Transient error MUST NOT wipe content!");

  const storedAfter500 = (await getChatbotKnowledgePages({ tenantId, chatbotId })).find((p) => p.url === page1Url);
  assert.equal(storedAfter500.status, "INDEXED", "Status must remain INDEXED");
  assert.ok(storedAfter500.content_text.includes("2,50,000"), "Valid content preserved during failure");
  console.log("  ✓ Transient error handled safely: Existing knowledge preserved without data loss.");

  // -----------------------------------------------------------------
  // TEST 7: Persistent Crawl State & 24h Scheduler (Acceptance 2, 4)
  // -----------------------------------------------------------------
  console.log("\n[TEST 7] Testing Persistent Crawl State & 24-Hour Scheduling...");
  const state = await getOrCreateCrawlState({
    tenantId,
    chatbotId,
    websiteUrl: "https://example.edu/sitemap.xml",
  });

  assert.ok(state, "Crawl state record should exist");
  assert.equal(state.website_url, "https://example.edu/sitemap.xml");

  // Fast forward next_check_at to 1 hour ago (due)
  await pool.execute(
    "UPDATE chatbot_crawl_states SET next_check_at = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id = ?",
    [state.id],
  );

  const dueJobs = await scheduleDueChatbots();
  const scheduledForTestBot = dueJobs.find((j) => j.chatbot_id === chatbotId);
  assert.ok(scheduledForTestBot, "Chatbot should be scheduled when next_check_at is past due");

  // Now set next_check_at to 23 hours in future (not due)
  await pool.execute(
    "UPDATE chatbot_crawl_states SET next_check_at = DATE_ADD(NOW(), INTERVAL 23 HOUR) WHERE id = ?",
    [state.id],
  );

  const notDueJobs = await scheduleDueChatbots();
  const notDueForTestBot = notDueJobs.find((j) => j.chatbot_id === chatbotId);
  assert.equal(notDueForTestBot, undefined, "Chatbot must NOT be scheduled when not due");
  console.log("  ✓ 24-hour due check verified: Due chatbots scheduled, non-due chatbots skipped.");

  // -----------------------------------------------------------------
  // TEST 8: Scheduler Deduplication & Idempotency (Acceptance 3, 18)
  // -----------------------------------------------------------------
  console.log("\n[TEST 8] Testing Scheduler Deduplication & Idempotency...");
  const testDedupKey = `test_dedup_${chatbotId}_${Date.now()}`;
  const job1 = await createCrawlJob({
    tenantId,
    chatbotId,
    jobType: "SCHEDULED",
    dedupKey: testDedupKey,
  });

  const job2 = await createCrawlJob({
    tenantId,
    chatbotId,
    jobType: "SCHEDULED",
    dedupKey: testDedupKey,
  });

  assert.equal(job1.id, job2.id, "Second createCrawlJob with same dedupKey must return existing job");
  const [matchingJobRows] = await pool.execute(
    "SELECT COUNT(*) as count FROM chatbot_crawl_jobs WHERE dedup_key = ?",
    [testDedupKey],
  );
  assert.equal(matchingJobRows[0].count, 1, "Exactly one job must exist in database");
  console.log("  ✓ Deduplication verified: Repeated schedule calls produce 0 duplicate records.");

  // -----------------------------------------------------------------
  // TEST 9: Multi-Worker Atomic Claiming & Concurrency (Acceptance 17)
  // -----------------------------------------------------------------
  console.log("\n[TEST 9] Testing Multi-Worker Atomic Claiming...");
  // Create test pending job
  const concurrencyJob = await createCrawlJob({
    tenantId,
    chatbotId,
    jobType: "SCHEDULED",
    dedupKey: `test_concurrency_${Date.now()}`,
  });

  // Worker 1 claims job
  const claimWorker1 = await claimNextCrawlJob("worker_alpha", 5);
  assert.ok(claimWorker1, "Worker 1 should successfully claim pending job");
  assert.equal(claimWorker1.locked_by, "worker_alpha");
  assert.equal(claimWorker1.status, "RUNNING");

  // Worker 2 attempts to claim next job
  const claimWorker2 = await claimNextCrawlJob("worker_beta", 5);
  // Either null or a different job, but NEVER claimWorker1.id!
  if (claimWorker2) {
    assert.notEqual(claimWorker2.id, claimWorker1.id, "Worker 2 must not claim job locked by Worker 1");
  }
  console.log("  ✓ Atomic claiming verified: Exclusive lock prevents concurrent worker collision.");

  // -----------------------------------------------------------------
  // TEST 10: Abandoned Job Recovery via Lease Expiration (Acceptance 15, 16)
  // -----------------------------------------------------------------
  console.log("\n[TEST 10] Testing Abandoned Job Recovery...");
  // Simulate worker crash by setting locked_until into the past
  await pool.execute(
    "UPDATE chatbot_crawl_jobs SET status = 'RUNNING', locked_until = DATE_SUB(NOW(), INTERVAL 10 MINUTE) WHERE id = ?",
    [claimWorker1.id],
  );

  const recoveredJob = await claimNextCrawlJob("worker_recovery", 5);
  assert.ok(recoveredJob, "Abandoned job should be recovered by new worker");
  assert.equal(recoveredJob.id, claimWorker1.id);
  assert.equal(recoveredJob.locked_by, "worker_recovery");
  assert.ok(recoveredJob.attempts >= 2, "Attempts count should be incremented upon recovery");
  console.log("  ✓ Abandoned job recovery verified: Expired lease recovered cleanly by standby worker.");

  // Clean up test job
  await pool.execute("DELETE FROM chatbot_crawl_jobs WHERE id = ?", [claimWorker1.id]);

  // -----------------------------------------------------------------
  // TEST 11: Retention Cleanup (Acceptance 18)
  // -----------------------------------------------------------------
  console.log("\n[TEST 11] Testing Job Retention Cleanup...");
  // Create an old completed job record (> 35 days old)
  await pool.execute(
    `INSERT INTO chatbot_crawl_jobs
      (tenant_id, chatbot_id, job_type, dedup_key, status, completed_at)
     VALUES (?, ?, 'SCHEDULED', ?, 'COMPLETED', DATE_SUB(NOW(), INTERVAL 35 DAY))`,
    [tenantId, chatbotId, `test_old_job_${Date.now()}`],
  );

  const cleanupRes = await cleanupOldCrawlJobs(30);
  assert.ok(cleanupRes.deletedCount >= 1, "Should clean up jobs older than 30 days");

  // Verify knowledge pages and crawl states were NOT deleted
  const statsAfterCleanup = await getChatbotKnowledgeStats({ tenantId, chatbotId });
  assert.ok(statsAfterCleanup.totalPages >= 1, "Knowledge pages must remain untouched during job cleanup");
  console.log("  ✓ Retention cleanup verified: Old jobs purged without touching knowledge pages.");

  // -----------------------------------------------------------------
  // TEST 12: Grounded Text Chat Response with Updated Knowledge (Acceptance 20, 21)
  // -----------------------------------------------------------------
  console.log("\n[TEST 12] Testing Grounded Gemini Text Chat with Revised Website Knowledge...");
  if (!isGeminiConfigured()) {
    throw new Error("GEMINI_API_KEY is not configured in backend environment!");
  }

  const liveExcerpts = await searchKnowledgeExcerpts({
    tenantId,
    chatbotId,
    query: "What is the tuition fee for B.Tech in Artificial Intelligence?",
  });

  const chatResponse = await generateGroundedResponse({
    chatbotName: testChatbot.name,
    personality: "Professional",
    language: "English",
    excerpts: liveExcerpts,
    userQuestion: "What is the tuition fee for B.Tech in Artificial Intelligence?",
  });

  console.log("  ✓ Grounded Answer with Updated Knowledge:");
  console.log("    -->", chatResponse.reply.trim().replace(/\n/g, " "));
  assert.ok(
    chatResponse.reply.includes("2,50,000") || chatResponse.reply.includes("250000"),
    "Gemini response must be grounded with revised fee amount INR 2,50,000!",
  );
  console.log("  ✓ Text Chat successfully grounded in revised website content.");

  // -----------------------------------------------------------------
  // TEST 13: Clean Cleanup of Test Knowledge Records
  // -----------------------------------------------------------------
  await pool.execute(
    "DELETE FROM chatbot_knowledge_pages WHERE chatbot_id = ? AND url IN (?, ?, ?)",
    [chatbotId, page1Url, page2Url, page3Url],
  );
  await pool.execute(
    "DELETE FROM chatbot_crawl_jobs WHERE chatbot_id = ? AND dedup_key LIKE 'test_%'",
    [chatbotId],
  );
  console.log("  ✓ Test artifacts cleaned up safely.");

  console.log("\n=================================================================");
  console.log("🎉 ALL PHASE 2 VERIFICATION TESTS PASSED WITH 100% SUCCESS! 🎉");
  console.log("=================================================================\n");
}

runPhase2Tests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ PHASE 2 TEST SUITE FAILED:", err);
    process.exit(1);
  });
