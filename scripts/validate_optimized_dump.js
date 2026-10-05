import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import readline from "node:readline";

const OPTIMIZED_DUMP_PATH = path.resolve("b:/solmento_ai_3rd_Oct/server/Database_storage/Dump20261005_optimized.sql");

async function validateDump() {
  console.log("=== VALIDATING OPTIMIZED DUMP: Dump20261005_optimized.sql ===");

  const stats = await fs.stat(OPTIMIZED_DUMP_PATH);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  console.log(`File Size: ${stats.size} bytes (${sizeMB} MB)`);

  const createdTables = new Set();
  const insertTables = new Set();
  let insertRowCount = 0;

  const inputStream = fsSync.createReadStream(OPTIMIZED_DUMP_PATH, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: inputStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    const createMatch = line.match(/^CREATE TABLE `([^`]+)`/i);
    if (createMatch) {
      createdTables.add(createMatch[1]);
    }
    const insertMatch = line.match(/^INSERT INTO `([^`]+)`/i);
    if (insertMatch) {
      insertTables.add(insertMatch[1]);
      insertRowCount++;
    }
  }

  console.log(`\nTable Schemas Created: ${createdTables.size} tables`);
  console.log(`Tables with INSERT Data: ${insertTables.size} tables`);
  console.log(`Total INSERT Statements: ${insertRowCount}`);

  console.log("\nCreated Tables List:");
  Array.from(createdTables).sort().forEach((t, i) => console.log(`  ${i + 1}. ${t}`));

  if (createdTables.size === 26) {
    console.log("\n✅ VALIDATION PASSED: All 26 table schemas successfully preserved!");
  } else {
    console.warn(`\n⚠️ WARNING: Table count is ${createdTables.size}, expected 26.`);
  }

  if (stats.size < 100 * 1024 * 1024) {
    console.log(`✅ VALIDATION PASSED: Final dump size (${sizeMB} MB) is BELOW 100 MB target!`);
  }
}

validateDump().catch(err => console.error("Validation error:", err));
