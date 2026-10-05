import { pool } from "../src/config/database.js";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import readline from "node:readline";

const SOURCE_DUMP_PATH = path.resolve("b:/solmento_ai_3rd_Oct/server/Database_storage/Dump20261005.sql");
const OPTIMIZED_DUMP_PATH = path.resolve("b:/solmento_ai_3rd_Oct/server/Database_storage/Dump20261005_optimized.sql");

async function generateOptimizedDump() {
  console.log("=== GENERATING OPTIMIZED DUMP: Dump20261005_optimized.sql ===");
  console.log(`Source Dump: ${SOURCE_DUMP_PATH}`);
  console.log(`Target Dump: ${OPTIMIZED_DUMP_PATH}`);

  // 1. DETERMINE SAFE KEEP IDS FROM MYSQL DB (READ-ONLY)
  
  // A. Top 3 version IDs per chatbot from chatbot_versions
  const [versionRows] = await pool.query(`
    SELECT id, chatbot_id, version_number
      FROM chatbot_versions
  `);
  
  const versionsByChatbot = {};
  for (const v of versionRows) {
    if (!versionsByChatbot[v.chatbot_id]) versionsByChatbot[v.chatbot_id] = [];
    versionsByChatbot[v.chatbot_id].push(v);
  }

  const keepVersionIds = new Set();
  for (const [cbId, versions] of Object.entries(versionsByChatbot)) {
    versions.sort((a, b) => b.version_number - a.version_number);
    // Keep top 3 versions for each chatbot
    versions.slice(0, 3).forEach(v => keepVersionIds.add(v.id));
  }
  console.log(`Identified ${keepVersionIds.size} chatbot_version IDs to KEEP (filtered out ${versionRows.length - keepVersionIds.size} stale version rows).`);

  // B. Active source knowledge page IDs from chatbot_knowledge_pages
  const [kpRows] = await pool.query(`
    SELECT kp.id, kp.chatbot_id, kp.source_fingerprint, cs.active_source_fingerprint, c.status as cbStatus
      FROM chatbot_knowledge_pages kp
      LEFT JOIN chatbot_crawl_states cs ON kp.chatbot_id = cs.chatbot_id
      LEFT JOIN chatbots c ON kp.chatbot_id = c.id
  `);

  const keepKnowledgeIds = new Set();
  for (const kp of kpRows) {
    // Keep page if it belongs to an active chatbot AND matches active source fingerprint (or if active_source_fingerprint is null/matching)
    if (kp.cbStatus === 'ACTIVE' && kp.source_fingerprint && kp.active_source_fingerprint && kp.source_fingerprint === kp.active_source_fingerprint) {
      keepKnowledgeIds.add(kp.id);
    } else if (!kp.active_source_fingerprint && kp.cbStatus === 'ACTIVE') {
      keepKnowledgeIds.add(kp.id);
    }
  }
  console.log(`Identified ${keepKnowledgeIds.size} chatbot_knowledge_page IDs to KEEP (filtered out ${kpRows.length - keepKnowledgeIds.size} stale crawl generation rows).`);

  // 2. PARSE SOURCE DUMP LINE BY LINE AND WRITE OPTIMIZED DUMP
  const inputStream = fsSync.createReadStream(SOURCE_DUMP_PATH, { encoding: "utf8" });
  const outputStream = fsSync.createWriteStream(OPTIMIZED_DUMP_PATH, { encoding: "utf8" });

  const rl = readline.createInterface({
    input: inputStream,
    crlfDelay: Infinity
  });

  let linesWritten = 0;
  let linesFiltered = 0;
  let currentTable = null;

  for await (const line of rl) {
    // Detect table context
    const insertMatch = line.match(/^INSERT INTO `([^`]+)` VALUES \((.+)\);?$/i);
    if (insertMatch) {
      currentTable = insertMatch[1];

      if (currentTable === "chatbot_versions") {
        // Parse row ID from first value: (id, ...
        const valStr = insertMatch[2];
        const idMatch = valStr.match(/^(\d+),/);
        if (idMatch) {
          const rowId = Number(idMatch[1]);
          if (!keepVersionIds.has(rowId)) {
            linesFiltered++;
            continue; // Skip stale version row
          }
        }
      } else if (currentTable === "chatbot_knowledge_pages") {
        // Parse row ID
        const valStr = insertMatch[2];
        const idMatch = valStr.match(/^(\d+),/);
        if (idMatch) {
          const rowId = Number(idMatch[1]);
          if (!keepKnowledgeIds.has(rowId)) {
            linesFiltered++;
            continue; // Skip stale crawl page row
          }
        }
      }
    }

    outputStream.write(line + "\n");
    linesWritten++;
  }

  outputStream.end();
  await new Promise(resolve => outputStream.on("finish", resolve));

  // 3. MEASURE OPTIMIZED FILE SIZE
  const optStats = await fs.stat(OPTIMIZED_DUMP_PATH);
  const optSizeBytes = optStats.size;
  const optSizeMB = (optSizeBytes / (1024 * 1024)).toFixed(2);
  const optSizeKB = (optSizeBytes / 1024).toFixed(2);

  const origStats = await fs.stat(SOURCE_DUMP_PATH);
  const origSizeMB = (origStats.size / (1024 * 1024)).toFixed(2);

  const savingsMB = (origSizeMB - optSizeMB).toFixed(2);
  const savingsPct = (((origSizeMB - optSizeMB) / origSizeMB) * 100).toFixed(2);

  console.log("\n=======================================================");
  console.log("OPTIMIZED DUMP CREATED SUCCESSFULLY");
  console.log("=======================================================");
  console.log(`Original Dump (Dump20261005.sql):           ${origSizeMB} MB`);
  console.log(`Optimized Dump (Dump20261005_optimized.sql): ${optSizeMB} MB (${optSizeKB} KB)`);
  console.log(`Total Reduction:                           ${savingsMB} MB (${savingsPct}%)`);
  console.log(`Target < 100 MB Result:                    ${optSizeMB < 100 ? '✅ PASS' : '❌ FAIL'}`);
}

generateOptimizedDump().then(() => pool.end()).catch(err => {
  console.error("Dump generation error:", err);
  pool.end();
});
