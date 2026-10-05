import { pool } from "../src/config/database.js";
import fs from "node:fs/promises";

async function runDeepAudit() {
  console.log("=== DEEP FORENSIC AUDIT OF TOP SIZE CONTRIBUTORS ===");

  // 1. AUDIT CHATBOT_VERSIONS
  console.log("\n--- 1. AUDIT: chatbot_versions ---");
  const [versionRows] = await pool.query(`
    SELECT 
      cv.id,
      cv.chatbot_id,
      cv.version_number,
      cv.created_at,
      OCTET_LENGTH(cv.config_json) as configJsonBytes,
      c.name as chatbotName,
      c.status as chatbotStatus
    FROM chatbot_versions cv
    LEFT JOIN chatbots c ON cv.chatbot_id = c.id
  `);

  console.log(`Total rows in chatbot_versions: ${versionRows.length}`);
  let activeVersionBytes = 0;
  let latestVersionBytes = 0; // Latest 1 per chatbot
  let top3VersionBytes = 0;   // Latest 3 per chatbot
  let oldVersionBytes = 0;

  const versionsByChatbot = {};
  for (const v of versionRows) {
    if (!versionsByChatbot[v.chatbot_id]) {
      versionsByChatbot[v.chatbot_id] = [];
    }
    versionsByChatbot[v.chatbot_id].push(v);
  }

  let activeVersionCount = 0;
  let latestVersionCount = 0;
  let top3VersionCount = 0;

  for (const [chatbotId, versions] of Object.entries(versionsByChatbot)) {
    versions.sort((a, b) => b.version_number - a.version_number);
    versions.forEach((v, idx) => {
      const bytes = v.configJsonBytes || 0;
      if (v.isActiveVersion) {
        activeVersionBytes += bytes;
        activeVersionCount++;
      }
      if (idx === 0) {
        latestVersionBytes += bytes;
        latestVersionCount++;
      }
      if (idx < 3) {
        top3VersionBytes += bytes;
        top3VersionCount++;
      } else {
        oldVersionBytes += bytes;
      }
    });
  }

  const totalVersionBytes = versionRows.reduce((acc, v) => acc + (v.configJsonBytes || 0), 0);
  const totalVersionMB = (totalVersionBytes / (1024 * 1024)).toFixed(2);
  const latestVersionMB = (latestVersionBytes / (1024 * 1024)).toFixed(2);
  const top3VersionMB = (top3VersionBytes / (1024 * 1024)).toFixed(2);
  const oldVersionMB = (oldVersionBytes / (1024 * 1024)).toFixed(2);

  console.log(`Total raw config_json bytes in chatbot_versions: ${totalVersionBytes} (${totalVersionMB} MB)`);
  console.log(`- Latest 1 version per chatbot (${latestVersionCount} rows): ${latestVersionMB} MB`);
  console.log(`- Latest 3 versions per chatbot (${top3VersionCount} rows): ${top3VersionMB} MB`);
  console.log(`- Older historical versions beyond top 3 (${versionRows.length - top3VersionCount} rows): ${oldVersionMB} MB`);

  // 2. AUDIT CHATBOT_KNOWLEDGE_PAGES
  console.log("\n--- 2. AUDIT: chatbot_knowledge_pages ---");
  const [kpCols] = await pool.query(`SHOW COLUMNS FROM chatbot_knowledge_pages`);
  const kpColNames = kpCols.map(c => c.Field);
  console.log("chatbot_knowledge_pages columns:", kpColNames);

  const [kpRows] = await pool.query(`
    SELECT 
      kp.id,
      kp.chatbot_id,
      kp.source_fingerprint,
      kp.url,
      ${kpColNames.includes("clean_text") ? "OCTET_LENGTH(kp.clean_text)" : kpColNames.includes("content") ? "OCTET_LENGTH(kp.content)" : "0"} as mainTextBytes,
      ${kpColNames.includes("excerpts_json") ? "OCTET_LENGTH(kp.excerpts_json)" : "0"} as excerptsJsonBytes,
      cs.active_source_fingerprint,
      c.status as chatbotStatus,
      (kp.source_fingerprint IS NOT NULL AND kp.source_fingerprint = cs.active_source_fingerprint) as isActiveSource
    FROM chatbot_knowledge_pages kp
    LEFT JOIN chatbot_crawl_states cs ON kp.chatbot_id = cs.chatbot_id
    LEFT JOIN chatbots c ON kp.chatbot_id = c.id
  `);

  let activeSourcePages = 0;
  let activeSourceBytes = 0;
  let inactiveSourcePages = 0;
  let inactiveSourceBytes = 0;
  let inactiveChatbotPages = 0;
  let inactiveChatbotBytes = 0;

  for (const p of kpRows) {
    const pBytes = (p.mainTextBytes || 0) + (p.excerptsJsonBytes || 0);
    if (p.chatbotStatus === 'INACTIVE' || !p.chatbotStatus) {
      inactiveChatbotPages++;
      inactiveChatbotBytes += pBytes;
    } else if (p.isActiveSource) {
      activeSourcePages++;
      activeSourceBytes += pBytes;
    } else {
      inactiveSourcePages++;
      inactiveSourceBytes += pBytes;
    }
  }

  const totalKpBytes = kpRows.reduce((acc, p) => acc + (p.mainTextBytes || 0) + (p.excerptsJsonBytes || 0), 0);
  const totalKpMB = (totalKpBytes / (1024 * 1024)).toFixed(2);
  const activeSourceMB = (activeSourceBytes / (1024 * 1024)).toFixed(2);
  const inactiveSourceMB = (inactiveSourceBytes / (1024 * 1024)).toFixed(2);
  const inactiveChatbotMB = (inactiveChatbotBytes / (1024 * 1024)).toFixed(2);

  console.log(`Total knowledge pages: ${kpRows.length} (${totalKpMB} MB)`);
  console.log(`- Pages of Active Fingerprint on Active Chatbots (${activeSourcePages} rows): ${activeSourceMB} MB`);
  console.log(`- Pages of Inactive Fingerprints on Active Chatbots (${inactiveSourcePages} rows): ${inactiveSourceMB} MB`);
  console.log(`- Pages belonging to Inactive/Deleted Chatbots (${inactiveChatbotPages} rows): ${inactiveChatbotMB} MB`);

  // 3. AUDIT CHATBOTS TABLE (config_json size per chatbot)
  console.log("\n--- 3. AUDIT: chatbots table ---");
  const [cbRows] = await pool.query(`
    SELECT id, name, status, OCTET_LENGTH(config_json) as configJsonBytes, created_at, updated_at
      FROM chatbots
  `);
  let activeChatbotConfigBytes = 0;
  let inactiveChatbotConfigBytes = 0;
  for (const cb of cbRows) {
    if (cb.status === 'ACTIVE') {
      activeChatbotConfigBytes += (cb.configJsonBytes || 0);
    } else {
      inactiveChatbotConfigBytes += (cb.configJsonBytes || 0);
    }
  }
  const totalCbMB = (cbRows.reduce((acc, c) => acc + (c.configJsonBytes || 0), 0) / (1024 * 1024)).toFixed(2);
  const activeCbMB = (activeChatbotConfigBytes / (1024 * 1024)).toFixed(2);
  const inactiveCbMB = (inactiveChatbotConfigBytes / (1024 * 1024)).toFixed(2);

  console.log(`Total chatbots: ${cbRows.length} (${totalCbMB} MB)`);
  console.log(`- Active Chatbots config_json (${cbRows.filter(c => c.status === 'ACTIVE').length} chatbots): ${activeCbMB} MB`);
  console.log(`- Inactive Chatbots config_json (${cbRows.filter(c => c.status !== 'ACTIVE').length} chatbots): ${inactiveCbMB} MB`);

  // 4. POTENTIAL SAVINGS SUMMARY
  console.log("\n=======================================================");
  console.log("FORENSIC REDUCTION SIMULATION SUMMARY");
  console.log("=======================================================");

  // Scenario 1: Retain top 3 versions per active chatbot, top 1 for inactive chatbots
  const scenario1VersionBytes = top3VersionBytes;
  const scenario1KnowledgeBytes = activeSourceBytes;
  const scenario1ChatbotBytes = activeChatbotConfigBytes + (inactiveChatbotConfigBytes * 0.1); // truncated/compact config for inactive

  const estimatedDumpBytesScenario1 =
    scenario1VersionBytes +
    scenario1KnowledgeBytes +
    scenario1ChatbotBytes +
    652987 + 279262 + 52139 + 41557 + 38834 + 25718 + 21325 + 17207 + 13247 + 11179 + 6213 + 30000;

  const estimatedDumpMBScenario1 = (estimatedDumpBytesScenario1 / (1024 * 1024)).toFixed(2);

  console.log(`Current Original SQL Dump Size: 200.08 MB`);
  console.log(`Estimated Optimized Dump Size (Retaining Top 3 Versions & Active Knowledge): ${estimatedDumpMBScenario1} MB`);
  console.log(`Potential Reduction: ${(200.08 - estimatedDumpMBScenario1).toFixed(2)} MB (${(((200.08 - estimatedDumpMBScenario1) / 200.08) * 100).toFixed(2)}% reduction)`);
  console.log(`Target < 100 MB Status: ${estimatedDumpMBScenario1 < 100 ? '✅ ACHIEVABLE' : '❌ NOT ACHIEVABLE'}`);
}

runDeepAudit().then(() => pool.end()).catch(err => {
  console.error("Deep audit error:", err);
  pool.end();
});
