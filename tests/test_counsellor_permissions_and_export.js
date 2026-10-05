import dotenv from "dotenv";
dotenv.config({ path: "./backend/.env" });
import { pool } from "../src/config/database.js";
import { exportAuditLogs, recordAudit } from "../src/services/auditService.js";
import { updateRolePermissions } from "../src/services/roleService.js";
import { getUserPermissions } from "../src/middleware/rbac.js";

async function runTests() {
  console.log("=================================================================");
  console.log("STARTING TEST SUITE: COUNSELLOR PERMISSIONS & EXPORT AUDIT LOGS");
  console.log("=================================================================");

  try {
    // ---------------------------------------------------------
    // SECTION 1: AUDIT LOGS CSV EXPORT & TENANT ISOLATION
    // ---------------------------------------------------------
    console.log("\n--- SECTION 1: Audit Logs Export & Filter Verification ---");

    const testTenantId = 999;
    const otherTenantId = 888;

    // Clean up test audit logs
    await pool.execute("DELETE FROM audit_logs WHERE tenant_id IN (?, ?)", [testTenantId, otherTenantId]);

    // Insert sample logs for testTenantId
    await recordAudit({
      tenantId: testTenantId,
      actorUserId: null,
      action: "Created",
      targetType: "Follow Ups",
      targetId: "1",
      metadata: {
        userName: "Counsellor Test",
        userEmail: "counsellor@test.com",
        userRole: "Counsellor",
        module: "Follow Ups",
        page: "Follow Ups",
        details: "Created follow-up scheduled for student",
      },
      ipAddress: "192.168.1.1",
      userAgent: "Mozilla/5.0 Chrome",
    });

    await recordAudit({
      tenantId: testTenantId,
      actorUserId: null,
      action: "Deleted",
      targetType: "Counsellor",
      targetId: "2",
      metadata: {
        userName: "Admin Test",
        userEmail: "admin@test.com",
        userRole: "Admin",
        module: "Counsellor",
        page: "Counsellor List",
        details: "Deleted counsellor account Vivek",
      },
      ipAddress: "192.168.1.2",
      userAgent: "Mozilla/5.0 Firefox",
    });

    // Insert log for otherTenantId (Tenant Isolation Test)
    await recordAudit({
      tenantId: otherTenantId,
      actorUserId: null,
      action: "Created",
      targetType: "Calls",
      targetId: "3",
      metadata: {
        userName: "Secret User",
        userEmail: "secret@other.com",
        userRole: "Admin",
        module: "Calls",
        page: "Calls",
        details: "Other tenant secret data",
      },
      ipAddress: "10.0.0.1",
    });

    // 1. Export all logs for testTenantId
    const csvData = await exportAuditLogs({ tenantId: testTenantId });
    console.log("✓ Export generated CSV length:", csvData.length);

    // Verify CSV Header & content
    if (!csvData.startsWith('"Date & Time","User","Role","Action","Module / Page","Details"')) {
      throw new Error("CSV Header mismatch!");
    }
    if (!csvData.includes("Counsellor Test") || !csvData.includes("Deleted counsellor account Vivek")) {
      throw new Error("CSV output missing expected tenant records!");
    }
    if (csvData.includes("Secret User") || csvData.includes("Other tenant secret data")) {
      throw new Error("TENANT ISOLATION FAILED: Other tenant logs leaked into export!");
    }
    if (csvData.includes("192.168.1.1") || csvData.includes("Mozilla/5.0")) {
      throw new Error("PRIVACY FAIL: IP Address or User Agent leaked into export CSV!");
    }
    console.log("✓ Tenant Isolation and Privacy (no IP/UserAgent) verified successfully!");

    // 2. Export with filter (Action: Deleted)
    const filteredCsv = await exportAuditLogs({ tenantId: testTenantId, action: "Deleted" });
    if (!filteredCsv.includes("Deleted counsellor account Vivek")) {
      throw new Error("Filtered CSV missing matching record!");
    }
    if (filteredCsv.includes("Counsellor Test")) {
      throw new Error("Filtered CSV contains non-matching record!");
    }
    console.log("✓ Filtered Export (Action: Deleted) verified successfully!");


    // ---------------------------------------------------------
    // SECTION 2: COUNSELLOR PERMISSION ENFORCEMENT & DYNAMIC TOGGLING
    // ---------------------------------------------------------
    console.log("\n--- SECTION 2: Counsellor RBAC & Dynamic Permission Toggling ---");

    // Create a custom role for testing dynamic permission updates
    const [existingTestRoles] = await pool.execute(
      "SELECT id FROM roles WHERE tenant_id = 1 AND name = 'Test Counsellor Role' LIMIT 1"
    );
    let testRoleId;
    if (existingTestRoles.length) {
      testRoleId = existingTestRoles[0].id;
    } else {
      const [res] = await pool.execute(
        "INSERT INTO roles (tenant_id, name, description, type, icon_key, status) VALUES (1, 'Test Counsellor Role', 'Test role', 'CUSTOM', 'users', 'ACTIVE')"
      );
      testRoleId = res.insertId;
    }
    console.log(`Using test role ID: ${testRoleId}`);

    const dummyCounsellorUser = {
      id: 9999,
      tenant_id: 1,
      role: "COUNSELLOR",
      custom_role_id: testRoleId,
      designation: "Test Counsellor",
    };

    // TEST 1 & TEST 2: Uncheck follow_ups.create & calls.create
    console.log("\n--- TEST 1 & 2: Disabling follow_ups.create & calls.create ---");
    await updateRolePermissions(testRoleId, 1, {
      permissionKeys: ["follow_ups.view", "calls.view"], // NO create permissions
    });

    let perms = await getUserPermissions(dummyCounsellorUser);
    console.log("Counsellor active permissions when create is unchecked:", perms);

    if (perms.includes("follow_ups.create") || perms.includes("calls.create")) {
      throw new Error("PERMISSION BUG: Counsellor still has create permissions after unchecking!");
    }
    console.log("✓ TEST 1 & 2 PASSED: Counsellor lacks follow_ups.create & calls.create when unchecked.");

    // TEST 5: Enable permissions dynamically
    console.log("\n--- TEST 5: Dynamically enabling follow_ups.create & calls.create ---");
    await updateRolePermissions(testRoleId, 1, {
      permissionKeys: ["follow_ups.view", "follow_ups.create", "calls.view", "calls.create"],
    });

    perms = await getUserPermissions(dummyCounsellorUser);
    console.log("Updated Counsellor active permissions when create is checked:", perms);

    if (!perms.includes("follow_ups.create") || !perms.includes("calls.create")) {
      throw new Error("PERMISSION BUG: Counsellor failed to receive create permissions when enabled!");
    }
    console.log("✓ TEST 5 PASSED: Counsellor received follow_ups.create & calls.create dynamically!");

    // TEST 6: Disable again
    console.log("\n--- TEST 6: Disabling permissions again ---");
    await updateRolePermissions(testRoleId, 1, {
      permissionKeys: ["follow_ups.view", "calls.view"],
    });

    perms = await getUserPermissions(dummyCounsellorUser);
    if (perms.includes("follow_ups.create") || perms.includes("calls.create")) {
      throw new Error("PERMISSION BUG: Counsellor permissions not revoked after second toggle!");
    }
    console.log("✓ TEST 6 PASSED: Counsellor permissions revoked dynamically again.");

    // Admin verification
    const adminUser = { id: 1, tenant_id: 1, role: "ADMIN" };
    const adminPerms = await getUserPermissions(adminUser);
    if (!adminPerms.includes("follow_ups.create") || !adminPerms.includes("calls.create")) {
      throw new Error("ADMIN BUG: Admin should always have full create permissions!");
    }
    console.log("✓ ADMIN TEST PASSED: Admin retains full creation permissions.");

    // Cleanup test role
    await pool.execute("DELETE FROM role_permissions WHERE role_id = ?", [testRoleId]);
    await pool.execute("DELETE FROM roles WHERE id = ?", [testRoleId]);

    // Clean up test logs
    await pool.execute("DELETE FROM audit_logs WHERE tenant_id IN (?, ?)", [testTenantId, otherTenantId]);

    console.log("\n=================================================================");
    console.log("ALL TESTS PASSED SUCCESSFULLY! 100% VERIFIED.");
    console.log("=================================================================");
  } catch (error) {
    console.error("\n❌ TEST FAILED:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runTests();
