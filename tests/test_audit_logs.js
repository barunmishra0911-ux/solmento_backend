import { pool } from "../src/config/database.js";
import { recordAudit, listAuditLogs } from "../src/services/auditService.js";

async function runAuditLogsTests() {
  console.log("=================================================================");
  console.log("TESTING AUDIT LOGS BACKEND + DATABASE INTEGRATION (PHASE 2)");
  console.log("=================================================================");

  const tenantA = 7;
  const tenantB = 99;

  // Cleanup test logs for tenant A & B
  await pool.execute("DELETE FROM audit_logs WHERE tenant_id IN (?, ?)", [tenantA, tenantB]);

  // 1. Record Audit Log Events for Tenant A (Suraj Admin, Barun Admin, Rishav Counsellor)
  console.log("\n--- 1. Recording Tenant A Audit Events ---");

  // Event 1: Suraj Admin Login
  await recordAudit({
    tenantId: tenantA,
    actorUserId: 101,
    action: "Logged In",
    targetType: "Authentication",
    targetId: "101",
    metadata: {
      userName: "Suraj Kumar",
      userEmail: "suraj@solmento.com",
      userRole: "Admin",
      module: "Authentication",
      page: "Login",
      details: "User logged in to the system",
      summaryTitle: "User Login",
      summarySubtitle: "User authenticated successfully",
    },
    ipAddress: "127.0.0.1",
  });
  console.log("✓ Recorded Suraj Admin Login event");

  // Event 2: Barun Admin Login
  await recordAudit({
    tenantId: tenantA,
    actorUserId: 102,
    action: "Logged In",
    targetType: "Authentication",
    targetId: "102",
    metadata: {
      userName: "Barun Mishra",
      userEmail: "barun@solmento.com",
      userRole: "Admin",
      module: "Authentication",
      page: "Login",
      details: "User logged in to the system",
      summaryTitle: "User Login",
      summarySubtitle: "User authenticated successfully",
    },
    ipAddress: "127.0.0.1",
  });
  console.log("✓ Recorded Barun Admin Login event");

  // Event 3: Suraj Admin updates Counsellor
  await recordAudit({
    tenantId: tenantA,
    actorUserId: 101,
    action: "Updated",
    targetType: "Counsellor",
    targetId: "CNS-001",
    metadata: {
      userName: "Suraj Kumar",
      userEmail: "suraj@solmento.com",
      userRole: "Admin",
      module: "Counsellor",
      page: "Edit Counsellor",
      details: "Updated counsellor details (ID: CNS-001)",
      fullDetails: "Updated counsellor details (ID: CNS-001). Changed phone number and department.",
      summaryTitle: "Counsellor Updated",
      summarySubtitle: "Counsellor information was updated",
    },
    ipAddress: "127.0.0.1",
  });
  console.log("✓ Recorded Counsellor Update event");

  // Event 4: Rishav Counsellor creates Follow-up
  await recordAudit({
    tenantId: tenantA,
    actorUserId: 103,
    action: "Created",
    targetType: "Follow Ups",
    targetId: "FUP-221",
    metadata: {
      userName: "Rishav Kumar",
      userEmail: "rishav@solmento.com",
      userRole: "Counsellor",
      module: "Follow Ups",
      page: "New Follow Up",
      details: "Created new follow-up (ID: FUP-221)",
      fullDetails: "Created new follow-up task (ID: FUP-221) scheduled for 28-09-2026.",
      summaryTitle: "Follow Up Created",
      summarySubtitle: "Follow up task was scheduled",
    },
    ipAddress: "127.0.0.1",
  });
  console.log("✓ Recorded Rishav Counsellor Follow-up creation event");

  // 2. Record Audit Event for Tenant B (Isolated Tenant)
  console.log("\n--- 2. Recording Tenant B Audit Event ---");
  await recordAudit({
    tenantId: tenantB,
    actorUserId: 999,
    action: "Created",
    targetType: "Lead",
    targetId: "L-999",
    metadata: {
      userName: "Tenant B Admin",
      userEmail: "admin@tenantb.com",
      userRole: "Admin",
      module: "Lead",
      page: "Create Lead",
      details: "Created lead L-999 for Tenant B",
    },
  });
  console.log("✓ Recorded Tenant B isolated audit event");

  // 3. Verify Shared Tenant Audit Stream & Filtering for Tenant A
  console.log("\n--- 3. Verifying Shared Tenant A Audit Stream ---");
  const tenantALogs = await listAuditLogs({ tenantId: tenantA, limit: 10 });
  console.log(`✓ Retrieved ${tenantALogs.logs.length} logs for Tenant A (total: ${tenantALogs.total})`);

  if (tenantALogs.total !== 4) {
    throw new Error(`Expected 4 audit logs for Tenant A, found ${tenantALogs.total}`);
  }

  // Confirm Tenant A sees events from all 3 users (Suraj, Barun, Rishav)
  const usersFound = new Set(tenantALogs.logs.map((l) => l.user.name));
  console.log("  Users present in Tenant A logs:", Array.from(usersFound));
  if (!usersFound.has("Suraj Kumar") || !usersFound.has("Barun Mishra") || !usersFound.has("Rishav Kumar")) {
    throw new Error("Shared tenant audit stream missing actor activities!");
  }

  // 4. Verify Strict Tenant Isolation
  console.log("\n--- 4. Verifying Strict Tenant Isolation ---");
  const tenantBLogs = await listAuditLogs({ tenantId: tenantB });
  console.log(`✓ Tenant B audit log count: ${tenantBLogs.total}`);
  if (tenantBLogs.total !== 1 || tenantBLogs.logs[0].user.name !== "Tenant B Admin") {
    throw new Error("Tenant B audit log isolation failed!");
  }

  // Confirm Tenant A logs do NOT contain Tenant B events
  const tenantAHasTenantB = tenantALogs.logs.some((l) => l.user.name === "Tenant B Admin");
  if (tenantAHasTenantB) {
    throw new Error("CRITICAL SECURITY FAILURE: Tenant A sees Tenant B audit logs!");
  }
  console.log("✓ Cross-tenant audit access strictly prevented.");

  // 5. Test Filters (Module, Action, User, Role, Search, Pagination)
  console.log("\n--- 5. Testing Query Filters & Pagination ---");

  // Module filter
  const counsellorLogs = await listAuditLogs({ tenantId: tenantA, module: "Counsellor" });
  console.log(`✓ Module filter ('Counsellor'): ${counsellorLogs.logs.length} match(es)`);
  if (counsellorLogs.total !== 1 || counsellorLogs.logs[0].module !== "Counsellor") {
    throw new Error("Module filter failed!");
  }

  // Action filter
  const createdLogs = await listAuditLogs({ tenantId: tenantA, action: "Created" });
  console.log(`✓ Action filter ('Created'): ${createdLogs.logs.length} match(es)`);
  if (createdLogs.total !== 1 || createdLogs.logs[0].action !== "Created") {
    throw new Error("Action filter failed!");
  }

  // Role filter
  const counsellorRoleLogs = await listAuditLogs({ tenantId: tenantA, role: "Counsellor" });
  console.log(`✓ Role filter ('Counsellor'): ${counsellorRoleLogs.logs.length} match(es)`);
  if (counsellorRoleLogs.total !== 1 || counsellorRoleLogs.logs[0].role !== "Counsellor") {
    throw new Error("Role filter failed!");
  }

  // Search filter
  const searchLogs = await listAuditLogs({ tenantId: tenantA, search: "CNS-001" });
  console.log(`✓ Search filter ('CNS-001'): ${searchLogs.logs.length} match(es)`);
  if (searchLogs.total !== 1 || !searchLogs.logs[0].details.includes("CNS-001")) {
    throw new Error("Search filter failed!");
  }

  // Pagination test
  const page1 = await listAuditLogs({ tenantId: tenantA, page: 1, limit: 2 });
  const page2 = await listAuditLogs({ tenantId: tenantA, page: 2, limit: 2 });
  console.log(`✓ Pagination: Page 1 count = ${page1.logs.length}, Page 2 count = ${page2.logs.length}`);
  if (page1.logs.length !== 2 || page2.logs.length !== 2) {
    throw new Error("Pagination failed!");
  }
  if (page1.logs[0].id === page2.logs[0].id) {
    throw new Error("Pagination offset failed (same item on both pages)!");
  }

  // 6. Verify Response Schema Privacy (No IP Address / User Agent in response)
  console.log("\n--- 6. Verifying Privacy & Security ---");
  const sampleLog = tenantALogs.logs[0];
  if (sampleLog.ipAddress || sampleLog.ip_address || sampleLog.userAgent) {
    throw new Error("IP Address or User Agent leaked in API response!");
  }
  console.log("✓ Confirmed: IP Address & User Agent are NOT exposed in user-facing audit log objects.");

  console.log("\n=================================================================");
  console.log("ALL AUDIT LOG BACKEND TESTS PASSED SUCCESSFULLY! ✓");
  console.log("=================================================================\n");
}

runAuditLogsTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
  });
