import os from "node:os";
import { pool } from "../config/database.js";
import { env } from "../config/env.js";
import {
  createCrawlJob,
  claimNextCrawlJob,
  executeCrawlJob,
  cleanupOldCrawlJobs,
} from "./crawlJobService.js";

const workerId = `worker_${os.hostname()}_${process.pid}_${Math.random().toString(36).slice(2, 7)}`;
let schedulerTimer = null;
let isTicking = false;
let lastCleanupAt = 0;

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
 * Finds all active chatbots with configured websites that are due for their 24-hour check.
 * Creates persistent scheduled crawl jobs with daily deduplication keys.
 */
export async function scheduleDueChatbots() {
  const [chatbots] = await pool.execute(`
    SELECT c.id, c.tenant_id, c.name, c.config_json,
           cs.website_url, cs.next_check_at, cs.last_checked_at
      FROM chatbots c
 LEFT JOIN chatbot_crawl_states cs ON cs.chatbot_id = c.id AND cs.tenant_id = c.tenant_id
     WHERE c.status = 'ACTIVE'
       AND (cs.next_check_at IS NULL OR cs.next_check_at <= NOW())
  `);

  const createdJobs = [];
  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  for (const bot of chatbots) {
    const config = safeParseConfig(bot.config_json);
    const websiteUrl = String(bot.website_url || config.websiteUrl || config.website_url || config.sitemapUrl || "").trim();
    if (!websiteUrl) continue;

    // Daily deduplication key ensures at most one scheduled job per chatbot per calendar day
    const dedupKey = `sched_${bot.id}_${todayStr}`;
    const job = await createCrawlJob({
      tenantId: bot.tenant_id,
      chatbotId: bot.id,
      jobType: "SCHEDULED",
      dedupKey,
    });
    createdJobs.push(job);
  }

  return createdJobs;
}

/**
 * Worker loop: claims and executes pending or recovered abandoned jobs.
 */
export async function processPendingJobs() {
  let processedCount = 0;
  const leaseMinutes = env.CRAWL_LEASE_MINUTES || 5;

  while (true) {
    const job = await claimNextCrawlJob(workerId, leaseMinutes);
    if (!job) break;

    try {
      console.log(`[CrawlWorker ${workerId}] Processing job #${job.id} (Chatbot #${job.chatbot_id})...`);
      const result = await executeCrawlJob(job);
      console.log(`[CrawlWorker ${workerId}] Job #${job.id} finished with status: ${result.status}`);
      processedCount++;
    } catch (err) {
      console.error(`[CrawlWorker ${workerId}] Error executing job #${job.id}:`, err);
    }
  }

  return { processedCount };
}

/**
 * Single scheduler tick: schedules due jobs, processes queue, and performs retention cleanup.
 */
export async function runSchedulerTick() {
  if (isTicking) return;
  isTicking = true;

  try {
    // 1. Schedule due chatbots
    await scheduleDueChatbots();

    // 2. Process all pending jobs
    await processPendingJobs();

    // 3. Daily retention cleanup of jobs older than retention days (default 30 days)
    const now = Date.now();
    if (now - lastCleanupAt > 24 * 60 * 60 * 1000) {
      const retentionDays = env.CRAWL_RETENTION_DAYS || 30;
      const cleanupRes = await cleanupOldCrawlJobs(retentionDays);
      if (cleanupRes.deletedCount > 0) {
        console.log(`[CrawlScheduler] Cleaned up ${cleanupRes.deletedCount} old crawl job records (> ${retentionDays} days).`);
      }
      lastCleanupAt = now;
    }
  } catch (err) {
    console.error("[CrawlScheduler] Tick error:", err.message);
  } finally {
    isTicking = false;
  }
}

/**
 * Starts the persistent crawl scheduler background service.
 */
export function startCrawlScheduler() {
  if (schedulerTimer) return;
  if (!env.CRAWL_SCHEDULER_ENABLED) {
    console.log("[CrawlScheduler] Scheduler is disabled by CRAWL_SCHEDULER_ENABLED=false.");
    return;
  }

  const intervalMs = (env.CRAWL_CHECK_INTERVAL_SEC || 60) * 1000;
  console.log(`[CrawlScheduler] Starting background crawl scheduler (interval: ${env.CRAWL_CHECK_INTERVAL_SEC}s, workerId: ${workerId})...`);

  // Run initial tick shortly after startup
  setTimeout(() => {
    runSchedulerTick().catch((e) => console.error("[CrawlScheduler] Initial tick error:", e));
  }, 3000);

  schedulerTimer = setInterval(() => {
    runSchedulerTick().catch((e) => console.error("[CrawlScheduler] Periodic tick error:", e));
  }, intervalMs);
}

/**
 * Stops the persistent crawl scheduler (for graceful shutdown / tests).
 */
export function stopCrawlScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log("[CrawlScheduler] Background crawl scheduler stopped.");
  }
}
