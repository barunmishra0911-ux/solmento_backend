import crypto from "node:crypto";
import { pool } from "../config/database.js";
import { runChangeDetectionCrawl, sanitizeCrawlLimit } from "./crawlerService.js";
import {
  getChatbotKnowledgePages,
  applyCrawlUpdates,
  getChatbotKnowledgeStats,
  generateWebsiteSuggestedQuestions,
  computeSourceFingerprint,
} from "./chatbotKnowledgeService.js";

function safeParseConfig(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * Gets or initializes the persistent crawl state for a chatbot.
 */
export async function getOrCreateCrawlState({ tenantId, chatbotId, websiteUrl }) {
  const newFingerprint = computeSourceFingerprint(websiteUrl);
  const [existing] = await pool.execute(
    "SELECT * FROM chatbot_crawl_states WHERE tenant_id = ? AND chatbot_id = ? LIMIT 1",
    [tenantId, chatbotId],
  );

  if (existing.length > 0) {
    if (websiteUrl && (existing[0].website_url !== websiteUrl || existing[0].source_fingerprint !== newFingerprint)) {
      const isDifferentSource = Boolean(existing[0].source_fingerprint && existing[0].source_fingerprint !== newFingerprint);
      await pool.execute(
        `UPDATE chatbot_crawl_states
            SET website_url = ?,
                source_fingerprint = ?,
                last_check_status = CASE WHEN ? = 1 THEN 'RECONFIGURING' ELSE last_check_status END,
                active_source_fingerprint = CASE WHEN ? = 1 THEN NULL ELSE active_source_fingerprint END
          WHERE id = ?`,
        [websiteUrl, newFingerprint, isDifferentSource ? 1 : 0, isDifferentSource ? 1 : 0, existing[0].id],
      );
      existing[0].website_url = websiteUrl;
      existing[0].source_fingerprint = newFingerprint;
      if (isDifferentSource) {
        existing[0].last_check_status = "RECONFIGURING";
        existing[0].active_source_fingerprint = null;
      }
    }
    return existing[0];
  }

  // Initialize new state record with next_check_at = NOW() so it is checked on next scheduler run
  const [insertRes] = await pool.execute(
    `INSERT INTO chatbot_crawl_states
      (tenant_id, chatbot_id, website_url, source_fingerprint, next_check_at, last_check_status)
     VALUES (?, ?, ?, ?, NOW(), 'PENDING')
     ON DUPLICATE KEY UPDATE website_url = VALUES(website_url), source_fingerprint = VALUES(source_fingerprint)`,
    [tenantId, chatbotId, websiteUrl || "", newFingerprint],
  );

  const [created] = await pool.execute(
    "SELECT * FROM chatbot_crawl_states WHERE id = ? OR (tenant_id = ? AND chatbot_id = ?)",
    [insertRes.insertId, tenantId, chatbotId],
  );
  return created[0];
}

/**
 * Retrieves crawl state for a chatbot.
 */
export async function getCrawlState({ tenantId, chatbotId }) {
  const [rows] = await pool.execute(
    "SELECT * FROM chatbot_crawl_states WHERE tenant_id = ? AND chatbot_id = ? LIMIT 1",
    [tenantId, chatbotId],
  );
  return rows[0] || null;
}

/**
 * Retrieves the latest crawl job for a chatbot.
 */
export async function getLatestCrawlJob({ tenantId, chatbotId }) {
  const [rows] = await pool.execute(
    "SELECT * FROM chatbot_crawl_jobs WHERE tenant_id = ? AND chatbot_id = ? ORDER BY id DESC LIMIT 1",
    [tenantId, chatbotId],
  );
  return rows[0] || null;
}

/**
 * Creates or retrieves a persistent crawl job.
 * Avoids duplicate jobs using dedup_key unique constraint.
 */
export async function createCrawlJob({
  tenantId,
  chatbotId,
  jobType = "SCHEDULED",
  dedupKey,
}) {
  const key =
    dedupKey ||
    `${jobType.toLowerCase()}_${chatbotId}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

  await pool.execute(
    `INSERT INTO chatbot_crawl_jobs
      (tenant_id, chatbot_id, job_type, dedup_key, status)
     VALUES (?, ?, ?, ?, 'PENDING')
     ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
    [tenantId, chatbotId, jobType, key],
  );

  const [rows] = await pool.execute(
    "SELECT * FROM chatbot_crawl_jobs WHERE dedup_key = ? LIMIT 1",
    [key],
  );
  return rows[0];
}

/**
 * Atomically claims the next pending or abandoned crawl job.
 * Prevents multiple workers from executing the same job.
 * Recovers abandoned jobs after worker crash via lease expiration (locked_until < NOW()).
 */
export async function claimNextCrawlJob(workerId, leaseMinutes = 5) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Select candidate job: PENDING, or RUNNING with expired lease
    const [candidates] = await connection.execute(
      `SELECT id, tenant_id, chatbot_id, job_type, dedup_key, attempts, max_attempts
         FROM chatbot_crawl_jobs
        WHERE (status = 'PENDING' OR (status = 'RUNNING' AND locked_until < NOW()))
          AND attempts < max_attempts
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE`,
    );

    if (!candidates.length) {
      await connection.commit();
      return null;
    }

    const candidate = candidates[0];

    // Atomically claim candidate job with worker ID and lease timeout
    await connection.execute(
      `UPDATE chatbot_crawl_jobs
          SET status = 'RUNNING',
              locked_by = ?,
              locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE),
              started_at = COALESCE(started_at, NOW()),
              attempts = attempts + 1,
              updated_at = NOW()
        WHERE id = ?`,
      [workerId, leaseMinutes, candidate.id],
    );

    await connection.commit();

    const [claimedRows] = await pool.execute(
      "SELECT * FROM chatbot_crawl_jobs WHERE id = ?",
      [candidate.id],
    );
    return claimedRows[0];
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

/**
 * Executes a crawl job using the change-detection strategy and updates all records.
 */
export async function executeCrawlJob(job) {
  const { id: jobId, tenant_id: tenantId, chatbot_id: chatbotId } = job;

  // 1. Fetch chatbot configuration
  const [chatbots] = await pool.execute(
    "SELECT id, tenant_id, name, config_json FROM chatbots WHERE id = ? AND tenant_id = ? LIMIT 1",
    [chatbotId, tenantId],
  );

  if (!chatbots.length) {
    await pool.execute(
      "UPDATE chatbot_crawl_jobs SET status = 'FAILED', error_message = 'Chatbot not found', completed_at = NOW() WHERE id = ?",
      [jobId],
    );
    return { success: false, error: "Chatbot not found" };
  }

  const chatbot = chatbots[0];
  const config = safeParseConfig(chatbot.config_json);

  const [states] = await pool.execute(
    "SELECT website_url FROM chatbot_crawl_states WHERE chatbot_id = ? AND tenant_id = ? LIMIT 1",
    [chatbotId, tenantId],
  );

  const websiteUrl = String(
    config.websiteUrl ||
    config.website_url ||
    config.sitemapUrl ||
    states[0]?.website_url ||
    "",
  ).trim();

  if (!websiteUrl) {
    await pool.execute(
      "UPDATE chatbot_crawl_jobs SET status = 'FAILED', error_message = 'No website URL configured', completed_at = NOW() WHERE id = ?",
      [jobId],
    );
    await pool.execute(
      `UPDATE chatbot_crawl_states
          SET last_checked_at = NOW(),
              last_check_status = 'FAILED',
              last_error_summary = 'No website URL configured'
        WHERE tenant_id = ? AND chatbot_id = ?`,
      [tenantId, chatbotId],
    );
    return { success: false, error: "No website URL configured", indexedCount: 0 };
  }

  const sourceFingerprint = computeSourceFingerprint(websiteUrl);

  // 2. Load existing knowledge pages for change detection scoped to current source fingerprint
  const existingPages = await getChatbotKnowledgePages({ tenantId, chatbotId, sourceFingerprint });

  // 3. Execute change detection crawl with sanitized limit
  const maxPages = sanitizeCrawlLimit(
    job.max_pages || config.crawlLimit || config.maxPages || config.crawl_limit,
  );

  let crawlReport;
  try {
    crawlReport = await runChangeDetectionCrawl(websiteUrl, {
      existingPages,
      maxPages,
    });
  } catch (err) {
    await pool.execute(
      `UPDATE chatbot_crawl_jobs
          SET status = 'FAILED',
              error_message = ?,
              completed_at = NOW(),
              locked_by = NULL,
              locked_until = NULL
        WHERE id = ?`,
      [err.message.slice(0, 1000), jobId],
    );

    await pool.execute(
      `UPDATE chatbot_crawl_states
          SET last_checked_at = NOW(),
              last_check_status = 'FAILED',
              last_error_summary = ?,
              next_check_at = DATE_ADD(NOW(), INTERVAL 24 HOUR)
        WHERE tenant_id = ? AND chatbot_id = ?`,
      [err.message.slice(0, 500), tenantId, chatbotId],
    );

    return { success: false, error: err.message };
  }

  // 4. Apply updates efficiently to database with source fingerprint
  const appliedCounts = await applyCrawlUpdates({
    tenantId,
    chatbotId,
    updates: {
      newPages: crawlReport.newPages,
      changedPages: crawlReport.changedPages,
      unchangedPages: crawlReport.unchangedPages,
      removedPages: crawlReport.removedPages,
    },
    sourceFingerprint,
  });

  const totalIndexedStats = await getChatbotKnowledgeStats({
    tenantId,
    chatbotId,
    sourceFingerprint,
  });

  // 5. Determine job outcome status with strict hierarchy
  const totalSuccessfulPages =
    crawlReport.newPages.length + crawlReport.changedPages.length + crawlReport.unchangedPages.length;

  let finalStatus = "COMPLETED";
  if (totalSuccessfulPages === 0 && totalIndexedStats.totalPages === 0) {
    finalStatus = "FAILED";
  } else if (
    crawlReport.totalDiscoveredCount > maxPages ||
    (crawlReport.totalDiscoveredCount > crawlReport.processedCount && crawlReport.processedCount >= maxPages) ||
    crawlReport.failedPages.length > 0
  ) {
    finalStatus = "PARTIAL";
  } else if (
    existingPages.length > 0 &&
    appliedCounts.newCount === 0 &&
    appliedCounts.changedCount === 0 &&
    appliedCounts.removedCount === 0 &&
    crawlReport.failedPages.length === 0
  ) {
    finalStatus = "UNCHANGED";
  } else {
    finalStatus = "COMPLETED";
  }

  if (totalIndexedStats.totalPages === 0 && finalStatus !== "PARTIAL") {
    finalStatus = "FAILED";
  }

  const shouldActivate = finalStatus !== "FAILED";

  const errorSummary =
    totalSuccessfulPages === 0 && totalIndexedStats.totalPages === 0
      ? `Failed to index any eligible pages from ${websiteUrl}. ${crawlReport.failedPages[0]?.error || ""}`.trim()
      : crawlReport.failedPages.length > 0
        ? `Indexed with transient errors on ${crawlReport.failedPages.length} page(s).`
        : crawlReport.totalDiscoveredCount > maxPages
          ? `Crawl limit reached: ${crawlReport.processedCount} of ${crawlReport.totalDiscoveredCount} URLs processed.`
          : null;

  // 6. Update job record
  await pool.execute(
    `UPDATE chatbot_crawl_jobs
        SET status = ?,
            pages_discovered = ?,
            pages_new = ?,
            pages_changed = ?,
            pages_unchanged = ?,
            pages_removed = ?,
            pages_failed = ?,
            error_message = ?,
            completed_at = NOW(),
            locked_by = NULL,
            locked_until = NULL
      WHERE id = ?`,
    [
      finalStatus,
      crawlReport.totalDiscoveredCount,
      appliedCounts.newCount,
      appliedCounts.changedCount,
      appliedCounts.unchangedCount,
      appliedCounts.removedCount,
      crawlReport.failedPages.length,
      errorSummary,
      jobId,
    ],
  );

  // 7. Update persistent crawl state with atomic activation
  await pool.execute(
    `INSERT INTO chatbot_crawl_states
      (tenant_id, chatbot_id, website_url, source_fingerprint, active_source_fingerprint,
       last_checked_at, last_successful_crawl_at, next_check_at,
       last_sitemap_hash, last_check_status, last_error_summary, total_pages_indexed,
       pages_discovered, pages_changed, pages_unchanged, pages_removed)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW(), DATE_ADD(NOW(), INTERVAL 24 HOUR), ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      website_url = VALUES(website_url),
      source_fingerprint = VALUES(source_fingerprint),
      active_source_fingerprint = CASE
        WHEN VALUES(last_check_status) != 'FAILED' THEN VALUES(source_fingerprint)
        ELSE active_source_fingerprint
      END,
      last_checked_at = NOW(),
      last_successful_crawl_at = CASE WHEN VALUES(last_check_status) != 'FAILED' THEN NOW() ELSE last_successful_crawl_at END,
      next_check_at = DATE_ADD(NOW(), INTERVAL 24 HOUR),
      last_sitemap_hash = COALESCE(VALUES(last_sitemap_hash), last_sitemap_hash),
      last_check_status = VALUES(last_check_status),
      last_error_summary = VALUES(last_error_summary),
      total_pages_indexed = VALUES(total_pages_indexed),
      pages_discovered = GREATEST(COALESCE(pages_discovered, 0), VALUES(pages_discovered), VALUES(total_pages_indexed)),
      pages_changed = VALUES(pages_changed),
      pages_unchanged = VALUES(pages_unchanged),
      pages_removed = VALUES(pages_removed)`,
    [
      tenantId,
      chatbotId,
      websiteUrl,
      sourceFingerprint,
      shouldActivate ? sourceFingerprint : null,
      crawlReport.sitemapHash || null,
      finalStatus,
      errorSummary,
      totalIndexedStats.totalPages,
      crawlReport.totalDiscoveredCount,
      appliedCounts.changedCount,
      appliedCounts.unchangedCount,
      appliedCounts.removedCount,
    ],
  );

  // 8. Update chatbot config_json for backward compatibility with UI
  const updatedConfig = {
    ...config,
    websiteUrl,
    crawled: shouldActivate,
    lastCrawledAt: new Date().toISOString(),
    indexedPagesCount: totalIndexedStats.totalPages,
    crawlStatus: finalStatus,
    crawlLimit: maxPages,
    maxPages,
    totalDiscoveredCount: crawlReport.totalDiscoveredCount,
    processedCount: crawlReport.processedCount,
    pagesChanged: appliedCounts.changedCount,
    pagesUnchanged: appliedCounts.unchangedCount,
    pagesNew: appliedCounts.newCount,
  };

  // 8.5 Derive and cache website-specific suggested questions if eligible
  try {
    const isCustomized = config.customizedSuggestedQuestions === true;
    const isLegacyCollegeDefault =
      Array.isArray(config.suggestedQuestions) &&
      config.suggestedQuestions.some((q) => {
        const t = typeof q === "string" ? q : q?.text;
        return /what courses do you offer|admission requirement|application deadline|how do i apply/i.test(t || "");
      });

    if (
      totalIndexedStats.totalPages > 0 &&
      (!isCustomized || isLegacyCollegeDefault || config.autoGeneratedQuestions || !config.suggestedQuestions || !config.suggestedQuestions.length)
    ) {
      const generatedQuestions = await generateWebsiteSuggestedQuestions({
        tenantId,
        chatbotId,
        sourceFingerprint,
      });

      if (generatedQuestions && generatedQuestions.length > 0) {
        updatedConfig.suggestedQuestions = generatedQuestions;
        updatedConfig.autoGeneratedQuestions = true;
      }
    }
  } catch (qErr) {
    console.warn(`[CrawlJobService] Failed to auto-generate suggested questions for chatbot ${chatbotId}:`, qErr.message);
  }

  await pool.execute(
    "UPDATE chatbots SET config_json = ?, published_config_json = ? WHERE id = ? AND tenant_id = ?",
    [
      JSON.stringify(updatedConfig),
      JSON.stringify({ ...safeParseConfig(chatbot.published_config_json), ...updatedConfig }),
      chatbotId,
      tenantId,
    ],
  );

  return {
    success: finalStatus !== "FAILED",
    status: finalStatus,
    discoveredCount: crawlReport.totalDiscoveredCount,
    totalDiscoveredCount: crawlReport.totalDiscoveredCount,
    processedCount: crawlReport.processedCount,
    indexedCount: totalIndexedStats.totalPages,
    newCount: appliedCounts.newCount,
    changedCount: appliedCounts.changedCount,
    unchangedCount: appliedCounts.unchangedCount,
    removedCount: appliedCounts.removedCount,
    failedCount: crawlReport.failedPages.length,
    isPartial: finalStatus === "PARTIAL",
    error: errorSummary,
  };
}

/**
 * Retention cleanup: safely deletes historical job records older than retentionDays.
 * Knowledge pages and crawl states are NEVER deleted.
 */
export async function cleanupOldCrawlJobs(retentionDays = 30) {
  const [res] = await pool.execute(
    `DELETE FROM chatbot_crawl_jobs
      WHERE status IN ('COMPLETED', 'UNCHANGED', 'PARTIAL', 'FAILED')
        AND completed_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [retentionDays],
  );
  return { deletedCount: res.affectedRows };
}
