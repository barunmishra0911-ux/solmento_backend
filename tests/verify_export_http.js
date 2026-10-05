import { signAccessToken } from "../src/middleware/auth.js";
import { pool } from "../src/config/database.js";

async function verifyExportHttp() {
  console.log("=================================================================");
  console.log("VERIFYING EXPORT AUDIT LOGS HTTP ENDPOINT & FILE DOWNLOAD FLOW");
  console.log("=================================================================");

  // 1. Fetch active admin user from database with tenant context
  const [users] = await pool.execute(
    "SELECT id, tenant_id AS tenantId, role, email FROM users WHERE role = 'ADMIN' AND tenant_id IS NOT NULL AND status = 'ACTIVE' LIMIT 1"
  );

  let admin;
  if (users.length) {
    admin = users[0];
  } else {
    admin = { id: 1, tenantId: 1, role: "ADMIN", email: "suraj@gmail.com" };
  }
  console.log(`Using admin user ID: ${admin.id}, Email: ${admin.email}, Tenant: ${admin.tenantId}`);

  // Generate JWT token using signAccessToken helper
  const token = signAccessToken(admin);

  const baseUrl = "http://localhost:5000/api/admin/audit-logs/export";

  // Test 1: Full export GET request with Authorization header
  console.log("\n--- TEST 1: End-to-End GET request to export endpoint ---");
  const res1 = await fetch(baseUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  console.log("Response status:", res1.status);
  console.log("Content-Type:", res1.headers.get("content-type"));
  console.log("Content-Disposition:", res1.headers.get("content-disposition"));

  if (res1.status !== 200) {
    throw new Error(`Expected HTTP 200, got ${res1.status}`);
  }
  if (!res1.headers.get("content-type")?.includes("text/csv")) {
    throw new Error("Expected Content-Type text/csv");
  }
  const contentDisp = res1.headers.get("content-disposition");
  if (!contentDisp || !contentDisp.includes("attachment") || !contentDisp.includes("solmento-audit-logs-")) {
    throw new Error(`Invalid Content-Disposition header: ${contentDisp}`);
  }

  const csvBody1 = await res1.text();
  console.log("CSV length:", csvBody1.length, "bytes");
  console.log("CSV Preview:\n", csvBody1.split("\n").slice(0, 4).join("\n"));

  const headerLine = '"Date & Time","User","Role","Action","Module / Page","Details"';
  if (!csvBody1.startsWith(headerLine)) {
    throw new Error("CSV does not start with expected header line!");
  }
  if (csvBody1.includes("192.168.1.1") || csvBody1.includes("Mozilla/5.0")) {
    throw new Error("Privacy failure: IP Address or User Agent leaked into export!");
  }
  console.log("✓ TEST 1 PASSED: HTTP status 200, correct headers & valid CSV body.");

  // Test 2: Export with specific filters (Action: Created)
  console.log("\n--- TEST 2: Filter preservation (Action: Created) ---");
  const res2 = await fetch(`${baseUrl}?action=Created`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res2.status !== 200) throw new Error("Filter request failed with " + res2.status);
  const csvBody2 = await res2.text();
  console.log("Filtered CSV length:", csvBody2.length);
  const lines2 = csvBody2.trim().split("\n");
  if (lines2.length > 1) {
    for (let i = 1; i < lines2.length; i++) {
      if (!lines2[i].includes('"Created"')) {
        throw new Error(`Non-matching record found in Action: Created export: ${lines2[i]}`);
      }
    }
  }
  console.log("✓ TEST 2 PASSED: Filters strictly respected.");

  // Test 3: Export with zero matching records
  console.log("\n--- TEST 3: Zero matching records returns valid CSV header ---");
  const res3 = await fetch(`${baseUrl}?search=NONEXISTENT_QUERY_STRING_XYZ_999`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res3.status !== 200) throw new Error("Zero records request failed");
  const csvBody3 = await res3.text();
  if (csvBody3.trim() !== headerLine) {
    throw new Error(`Expected only header row for empty export, got: ${csvBody3}`);
  }
  console.log("✓ TEST 3 PASSED: Returns valid CSV header row when zero matching records.");

  console.log("\n=================================================================");
  console.log("ALL HTTP & CSV EXPORT VERIFICATIONS PASSED 100%");
  console.log("=================================================================");
  await pool.end();
}

verifyExportHttp().catch((err) => {
  console.error("❌ Verification failed:", err);
  process.exit(1);
});
