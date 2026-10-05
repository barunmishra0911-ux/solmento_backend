import { pool } from "../src/config/database.js";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import readline from "node:readline";

const DUMP_PATH = path.resolve("b:/solmento_ai_3rd_Oct/server/Database_storage/Dump20261005.sql");

async function runAudit() {
  console.log("=== STARTING COMPLETE READ-ONLY MYSQL DATABASE & DUMP AUDIT ===");

  // 1. DUMP FILE STATS
  const dumpStats = await fs.stat(DUMP_PATH);
  const dumpSizeBytes = dumpStats.size;
  const dumpSizeMB = (dumpSizeBytes / (1024 * 1024)).toFixed(2);
  const dumpSizeKB = (dumpSizeBytes / 1024).toFixed(2);
  console.log(`\nDump File: ${DUMP_PATH}`);
  console.log(`Dump Size: ${dumpSizeBytes} bytes (${dumpSizeKB} KB / ${dumpSizeMB} MB)`);

  // 2. DATABASE INVENTORY FROM INFORMATION_SCHEMA
  const dbName = "solmento_ai";
  const [tablesInfo] = await pool.query(
    `SELECT 
        TABLE_NAME as tableName,
        ENGINE as engine,
        TABLE_ROWS as tableRows,
        DATA_LENGTH as dataBytes,
        INDEX_LENGTH as indexBytes,
        (DATA_LENGTH + INDEX_LENGTH) as totalBytes
       FROM information_schema.TABLES 
      WHERE TABLE_SCHEMA = ?
      ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC`,
    [dbName]
  );

  let totalDbDataBytes = 0;
  let totalDbIndexBytes = 0;
  let totalDbBytes = 0;

  const fullInventory = [];

  for (const row of tablesInfo) {
    // Get exact row count with SELECT COUNT(*) for accuracy
    let exactCount = Number(row.tableRows || 0);
    try {
      const [[{ cnt }]] = await pool.query(`SELECT COUNT(*) as cnt FROM \`${row.tableName}\``);
      exactCount = Number(cnt);
    } catch (e) {
      console.warn(`Could not fetch exact count for ${row.tableName}: ${e.message}`);
    }

    const dataMB = Number((Number(row.dataBytes || 0) / (1024 * 1024)).toFixed(4));
    const indexMB = Number((Number(row.indexBytes || 0) / (1024 * 1024)).toFixed(4));
    const totalMB = Number((Number(row.totalBytes || 0) / (1024 * 1024)).toFixed(4));

    totalDbDataBytes += Number(row.dataBytes || 0);
    totalDbIndexBytes += Number(row.indexBytes || 0);
    totalDbBytes += Number(row.totalBytes || 0);

    fullInventory.push({
      tableName: row.tableName,
      engine: row.engine,
      exactCount,
      dataBytes: Number(row.dataBytes || 0),
      indexBytes: Number(row.indexBytes || 0),
      totalBytes: Number(row.totalBytes || 0),
      dataMB,
      indexMB,
      totalMB
    });
  }

  const totalDbMB = Number((totalDbBytes / (1024 * 1024)).toFixed(2));
  const totalDbDataMB = Number((totalDbDataBytes / (1024 * 1024)).toFixed(2));
  const totalDbIndexMB = Number((totalDbIndexBytes / (1024 * 1024)).toFixed(2));

  console.log(`\nExact Database Name: ${dbName}`);
  console.log(`Total Table Count: ${fullInventory.length}`);
  console.log(`Total DB Storage: ${totalDbMB} MB (Data: ${totalDbDataMB} MB, Index: ${totalDbIndexMB} MB)`);

  // Add % of DB size
  for (const item of fullInventory) {
    item.percentOfDb = totalDbBytes > 0 ? Number(((item.totalBytes / totalDbBytes) * 100).toFixed(2)) : 0;
  }

  // Rank tables DESC by total size
  fullInventory.sort((a, b) => b.totalBytes - a.totalBytes);

  // 3. SQL DUMP BYTE CONTRIBUTION BY TABLE
  console.log("\nAnalyzing Dump File Byte Distribution per Table...");
  const tableDumpBytes = {};
  let schemaBytes = 0;

  const fileStream = fsSync.createReadStream(DUMP_PATH);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let currentTable = null;

  for await (const line of rl) {
    const lineLen = Buffer.byteLength(line, 'utf8') + 1; // include newline
    const insertMatch = line.match(/^INSERT INTO `([^`]+)`/i);
    if (insertMatch) {
      currentTable = insertMatch[1];
      tableDumpBytes[currentTable] = (tableDumpBytes[currentTable] || 0) + lineLen;
    } else {
      const tableIntroMatch = line.match(/^-- Table structure for table `([^`]+)`/i) || line.match(/^DROP TABLE IF EXISTS `([^`]+)`/i) || line.match(/^CREATE TABLE `([^`]+)`/i);
      if (tableIntroMatch) {
        currentTable = tableIntroMatch[1];
      }
      if (currentTable) {
        tableDumpBytes[currentTable] = (tableDumpBytes[currentTable] || 0) + lineLen;
      } else {
        schemaBytes += lineLen;
      }
    }
  }

  const dumpByteRanking = Object.entries(tableDumpBytes)
    .map(([table, bytes]) => ({
      tableName: table,
      dumpBytes: bytes,
      dumpMB: Number((bytes / (1024 * 1024)).toFixed(2)),
      dumpKB: Number((bytes / 1024).toFixed(2)),
      percentOfDump: Number(((bytes / dumpSizeBytes) * 100).toFixed(2))
    }))
    .sort((a, b) => b.dumpBytes - a.dumpBytes);

  // 4. DEEP AUDIT FOR CHATBOT CONVERSATIONS
  console.log("\nAuditing Chatbot Conversations...");
  const [convCols] = await pool.query(`SHOW COLUMNS FROM conversations`);
  const convColNames = convCols.map(c => c.Field);
  const hasLeadId = convColNames.includes("lead_id");
  const hasStatus = convColNames.includes("status");
  const hasIsDeleted = convColNames.includes("is_deleted");
  const hasDeletedAt = convColNames.includes("deleted_at");

  const [[convStats]] = await pool.query(`
    SELECT 
      COUNT(*) as totalConvs,
      ${hasLeadId ? 'COUNT(CASE WHEN lead_id IS NULL THEN 1 END)' : '0'} as anonConvs,
      ${hasStatus ? "COUNT(CASE WHEN status = 'CLOSED' THEN 1 END)" : '0'} as closedConvs,
      ${hasIsDeleted || hasDeletedAt ? `COUNT(CASE WHEN ${[hasIsDeleted ? 'is_deleted = 1' : '', hasDeletedAt ? 'deleted_at IS NOT NULL' : ''].filter(Boolean).join(' OR ')} THEN 1 END)` : '0'} as deletedConvs
    FROM conversations
  `);

  const [[msgStats]] = await pool.query(`
    SELECT 
      COUNT(*) as totalMsgs,
      AVG(length(content)) as avgMsgCharLen,
      SUM(length(content)) as totalMsgCharBytes
    FROM conversation_messages
  `);

  const [topConvsByMsgs] = await pool.query(`
    SELECT conversation_id, COUNT(*) as msgCount
      FROM conversation_messages
     GROUP BY conversation_id
     ORDER BY msgCount DESC
     LIMIT 5
  `);

  // 5. DEEP AUDIT FOR CRAWL & KNOWLEDGE PAGES
  console.log("\nAuditing Website Crawl & Knowledge Data...");
  const [kpCols] = await pool.query(`SHOW COLUMNS FROM chatbot_knowledge_pages`);
  const kpColNames = kpCols.map(c => c.Field);

  const lengthSumCols = [];
  if (kpColNames.includes("content")) lengthSumCols.push("SUM(LENGTH(content)) as totalContentBytes");
  if (kpColNames.includes("raw_html")) lengthSumCols.push("SUM(LENGTH(raw_html)) as totalRawHtmlBytes");
  if (kpColNames.includes("clean_text")) lengthSumCols.push("SUM(LENGTH(clean_text)) as totalCleanTextBytes");
  if (kpColNames.includes("excerpts_json")) lengthSumCols.push("SUM(LENGTH(excerpts_json)) as totalExcerptsBytes");

  const [[knowledgeStats]] = await pool.query(`
    SELECT 
      COUNT(*) as totalPages,
      COUNT(DISTINCT source_fingerprint) as distinctGenCount,
      COUNT(DISTINCT url) as distinctUrls
      ${lengthSumCols.length ? ', ' + lengthSumCols.join(', ') : ''}
    FROM chatbot_knowledge_pages
  `);

  const [genBreakdown] = await pool.query(`
    SELECT 
      kp.chatbot_id,
      kp.source_fingerprint,
      COUNT(*) as pageCount,
      ${kpColNames.includes("clean_text") ? 'SUM(LENGTH(kp.clean_text))' : '0'} as cleanTextBytes,
      cs.active_source_fingerprint,
      (kp.source_fingerprint = cs.active_source_fingerprint) as isActiveGen
    FROM chatbot_knowledge_pages kp
    LEFT JOIN chatbot_crawl_states cs ON kp.chatbot_id = cs.chatbot_id
    GROUP BY kp.chatbot_id, kp.source_fingerprint, cs.active_source_fingerprint
    ORDER BY pageCount DESC
  `);

  const [duplicateUrls] = await pool.query(`
    SELECT url, COUNT(*) as copies, COUNT(DISTINCT source_fingerprint) as gens
      FROM chatbot_knowledge_pages
     GROUP BY url
    HAVING copies > 1
     ORDER BY copies DESC
     LIMIT 10
  `);

  let crawlJobsStats = [];
  try {
    const [[crawlJobExists]] = await pool.query(`SHOW TABLES LIKE 'crawl_jobs'`);
    if (crawlJobExists) {
      const [res] = await pool.query(`SELECT status, COUNT(*) as cnt FROM crawl_jobs GROUP BY status`);
      crawlJobsStats = res;
    } else {
      const [[chatbotCrawlJobExists]] = await pool.query(`SHOW TABLES LIKE 'chatbot_crawl_jobs'`);
      if (chatbotCrawlJobExists) {
        const [res] = await pool.query(`SELECT status, COUNT(*) as cnt FROM chatbot_crawl_jobs GROUP BY status`);
        crawlJobsStats = res;
      }
    }
  } catch (e) {
    // skip
  }

  // 6. DEEP AUDIT FOR LOGS AND OTHER TABLES
  console.log("\nAuditing Log Tables & Soft Deletes...");
  const logTables = ["audit_logs", "activity_logs", "crawl_jobs", "user_activity_logs", "notification_logs"];
  const logAudit = [];

  for (const logT of logTables) {
    try {
      const [[checkExists]] = await pool.query(`SHOW TABLES LIKE ?`, [logT]);
      if (checkExists) {
        const [[{ rowCnt, oldest, newest }]] = await pool.query(
          `SELECT COUNT(*) as rowCnt, MIN(created_at) as oldest, MAX(created_at) as newest FROM \`${logT}\``
        );
        const dumpInfo = dumpByteRanking.find(d => d.tableName === logT);
        logAudit.push({
          tableName: logT,
          rowCnt,
          oldest,
          newest,
          dumpMB: dumpInfo ? dumpInfo.dumpMB : 0
        });
      }
    } catch (e) {
      console.warn(`Log table ${logT} check failed: ${e.message}`);
    }
  }

  // 7. CHECK SOFT DELETES
  const softDeleteAudit = [];
  for (const item of fullInventory) {
    try {
      const [columns] = await pool.query(`SHOW COLUMNS FROM \`${item.tableName}\``);
      const colNames = columns.map(c => c.Field);
      const hasDeletedAt = colNames.includes("deleted_at");
      const hasIsDeleted = colNames.includes("is_deleted");

      if (hasDeletedAt || hasIsDeleted) {
        let whereClause = [];
        if (hasDeletedAt) whereClause.push("deleted_at IS NOT NULL");
        if (hasIsDeleted) whereClause.push("is_deleted = 1");
        const sql = `SELECT COUNT(*) as softDeleted FROM \`${item.tableName}\` WHERE ${whereClause.join(" OR ")}`;
        const [[{ softDeleted }]] = await pool.query(sql);
        softDeleteAudit.push({
          tableName: item.tableName,
          totalRows: item.exactCount,
          softDeleted,
          activeRows: item.exactCount - softDeleted,
          dumpMB: dumpByteRanking.find(d => d.tableName === item.tableName)?.dumpMB || 0
        });
      }
    } catch (e) {
      // skip
    }
  }

  // OUTPUT AUDIT SUMMARY JSON FOR PARSING / REPORTING
  const finalReportData = {
    dumpFile: {
      path: DUMP_PATH,
      sizeBytes: dumpSizeBytes,
      sizeKB: dumpSizeKB,
      sizeMB: dumpSizeMB,
    },
    database: {
      dbName,
      totalTables: fullInventory.length,
      totalDataMB: totalDbDataMB,
      totalIndexMB: totalDbIndexMB,
      totalDbMB: totalDbMB
    },
    fullInventory,
    dumpByteRanking,
    schemaBytes,
    schemaMB: Number((schemaBytes / (1024 * 1024)).toFixed(4)),
    convStats: {
      ...convStats,
      ...msgStats,
      topConvsByMsgs
    },
    knowledgeStats: {
      ...knowledgeStats,
      genBreakdown,
      duplicateUrlsCount: duplicateUrls.length,
      topDuplicateUrls: duplicateUrls,
      crawlJobsStats
    },
    logAudit,
    softDeleteAudit
  };

  await fs.writeFile(
    path.resolve("b:/solmento_ai_3rd_Oct/server/Database_storage/audit_report_data.json"),
    JSON.stringify(finalReportData, null, 2)
  );
  console.log("\n✅ Audit Report Data saved to server/Database_storage/audit_report_data.json!");
}

runAudit().then(() => pool.end()).catch(err => {
  console.error("Audit error:", err);
  pool.end();
});
