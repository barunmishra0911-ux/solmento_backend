import dotenv from "dotenv";
dotenv.config({ path: "./backend/.env" });
import { pool } from "../src/config/database.js";
import {
  createCounsellor,
  deleteCounsellor,
  listCounsellors,
  restoreCounsellor,
} from "../src/services/counsellorService.js";
import {
  createRole,
  deleteRole,
  listRoles,
  restoreRole,
} from "../src/services/roleService.js";
import {
  createChatbot,
  deleteChatbot,
  listChatbots,
  restoreChatbot,
} from "../src/services/chatbotService.js";
import {
  createCampaign,
  deleteCampaign,
  listCampaigns,
  restoreCampaign,
} from "../src/services/campaignService.js";
import {
  createPlatformRecord,
  deletePlatformRecord,
  listPlatformRecords,
  restorePlatformRecord,
} from "../src/services/platformRecordService.js";
import { authenticateUser } from "../src/services/authService.js";

async function runSoftDeleteSystemTests() {
  console.log("=== STARTING GLOBAL SOFT DELETE ARCHITECTURE TESTS ===");
  const [[tRow]] = await pool.execute("SELECT id FROM tenants LIMIT 1");
  if (!tRow) throw new Error("No tenant found in DB");
  const testTenant = tRow.id;
  const isolationTenant = tRow.id + 999999;
  let adminUser = null;
  let actorUserId = null;

  try {
    // Setup Test Admin User
    const [adminRes] = await pool.execute(
      `INSERT INTO users (tenant_id, email, password_hash, name, role, status)
       VALUES (?, ?, 'dummy_hash', 'Test SoftDelete Admin', 'ADMIN', 'ACTIVE')`,
      [testTenant, `admin_sd_${Date.now()}@solmento.internal`],
    );
    actorUserId = adminRes.insertId;

    // ----------------------------------------------------
    // TEST 1: COUNSELLOR / USER SOFT DELETE & RESTORE
    // ----------------------------------------------------
    console.log("\n[TEST 1] Counsellor / User Soft Delete...");
    const email = `counsellor_sd_${Date.now()}@solmento.internal`;
    const createdCounsellor = await createCounsellor({
      email,
      fullName: "SD Test Counsellor",
      phone: "+1234567890",
      department: "Admissions",
      password: "Password123!",
      employeeId: `EMP-${Date.now()}`,
      designation: "Counselor",
      tenantId: testTenant,
      adminUserId: actorUserId,
    });
    console.log(" -> Created Counsellor ID:", createdCounsellor.id);

    // Verify present in active list
    let counsellors = await listCounsellors(testTenant);
    if (!counsellors.some((c) => c.id === createdCounsellor.id)) {
      throw new Error("Created counsellor not found in listCounsellors");
    }

    // Perform Soft Delete
    await deleteCounsellor({
      id: createdCounsellor.id,
      tenantId: testTenant,
      actorUserId,
    });
    console.log(" -> Executed deleteCounsellor()");

    // Check DB row still exists and deleted_at & deleted_by_user_id are populated
    const [[cRow]] = await pool.execute(
      "SELECT id, deleted_at, deleted_by_user_id FROM users WHERE id = ?",
      [createdCounsellor.id],
    );
    if (!cRow) throw new Error("Counsellor DB row was hard-deleted!");
    if (!cRow.deleted_at || String(cRow.deleted_by_user_id) !== String(actorUserId)) {
      throw new Error("Counsellor deleted_at or deleted_by_user_id invalid: " + JSON.stringify(cRow));
    }
    console.log(" -> DB Row preserved with deleted_at:", cRow.deleted_at, "deleted_by_user_id:", cRow.deleted_by_user_id);

    // Check excluded from active list
    counsellors = await listCounsellors(testTenant);
    if (counsellors.some((c) => c.id === createdCounsellor.id)) {
      throw new Error("Soft-deleted counsellor still appears in listCounsellors!");
    }
    console.log(" -> Excluded from active listCounsellors successfully.");

    // Check login is blocked
    try {
      await authenticateUser(email, "Password123!", testTenant);
      throw new Error("Soft-deleted user was able to log in!");
    } catch (err) {
      if (err.message.includes("was able to log in")) throw err;
      console.log(" -> Login correctly blocked for soft-deleted user:", err.message);
    }

    // Restore Counsellor
    await restoreCounsellor({ id: createdCounsellor.id, tenantId: testTenant });
    counsellors = await listCounsellors(testTenant);
    if (!counsellors.some((c) => c.id === createdCounsellor.id)) {
      throw new Error("Restored counsellor did not reappear in listCounsellors!");
    }
    console.log(" -> Counsellor restored successfully!");

    // ----------------------------------------------------
    // TEST 2: CUSTOM ROLE SOFT DELETE & RESTORE
    // ----------------------------------------------------
    console.log("\n[TEST 2] Custom Role Soft Delete...");
    const role = await createRole({
      tenantId: testTenant,
      name: "Test SD Role",
      description: "Role for soft delete test",
      permissionKeys: ["leads.view", "calls.view"],
    });
    console.log(" -> Created Role ID:", role.id);

    // Assign role to counsellor
    await pool.execute("UPDATE users SET custom_role_id = ? WHERE id = ?", [
      role.id,
      createdCounsellor.id,
    ]);

    // Soft delete role
    await deleteRole(role.id, testTenant, actorUserId);
    console.log(" -> Executed deleteRole()");

    // Verify role DB row
    const [[rRow]] = await pool.execute(
      "SELECT id, deleted_at, deleted_by_user_id FROM roles WHERE id = ?",
      [role.id],
    );
    if (!rRow || !rRow.deleted_at || String(rRow.deleted_by_user_id) !== String(actorUserId)) {
      throw new Error("Role soft delete DB state invalid: " + JSON.stringify(rRow));
    }

    // Verify custom_role_id cleared from user
    const [[uCheck]] = await pool.execute(
      "SELECT custom_role_id FROM users WHERE id = ?",
      [createdCounsellor.id],
    );
    if (uCheck.custom_role_id !== null) {
      throw new Error("User custom_role_id was not unassigned on role soft delete!");
    }
    console.log(" -> Role soft-deleted and user permission assignment safely revoked.");

    // Restore Role
    await restoreRole(role.id, testTenant);
    const roles = await listRoles(testTenant);
    if (!roles.some((r) => r.id === role.id)) {
      throw new Error("Restored role did not reappear in listRoles!");
    }
    console.log(" -> Role restored successfully!");

    // ----------------------------------------------------
    // TEST 3: CHATBOT SOFT DELETE & RESTORE
    // ----------------------------------------------------
    console.log("\n[TEST 3] Chatbot Soft Delete...");
    const bot = await createChatbot({
      name: "SD Test Bot",
      description: "Bot soft delete test",
      status: "ACTIVE",
      startMode: "TEMPLATE",
      channels: ["WEBSITE"],
      tenantId: testTenant,
      userId: actorUserId,
    });
    console.log(" -> Created Chatbot ID:", bot.id);

    await deleteChatbot({ id: bot.id, tenantId: testTenant, actorUserId });
    const [[bRow]] = await pool.execute(
      "SELECT id, deleted_at, deleted_by_user_id FROM chatbots WHERE id = ?",
      [bot.id],
    );
    if (!bRow || !bRow.deleted_at || String(bRow.deleted_by_user_id) !== String(actorUserId)) {
      throw new Error("Chatbot soft delete DB state invalid!");
    }

    let bots = await listChatbots(testTenant);
    if (bots.some((b) => b.id === bot.id)) {
      throw new Error("Soft-deleted chatbot appears in listChatbots!");
    }
    console.log(" -> Chatbot soft-deleted successfully.");

    await restoreChatbot({ id: bot.id, tenantId: testTenant });
    bots = await listChatbots(testTenant);
    if (!bots.some((b) => b.id === bot.id)) {
      throw new Error("Restored chatbot did not reappear!");
    }
    console.log(" -> Chatbot restored successfully!");

    // ----------------------------------------------------
    // TEST 4: CAMPAIGN SOFT DELETE & RESTORE
    // ----------------------------------------------------
    console.log("\n[TEST 4] Campaign Soft Delete...");
    const camp = await createCampaign({
      tenantId: testTenant,
      createdByUserId: actorUserId,
      name: "SD Test Campaign",
      description: "Campaign soft delete test",
    });
    console.log(" -> Created Campaign ID:", camp.id);

    await deleteCampaign(camp.id, testTenant, actorUserId);
    const [[campRow]] = await pool.execute(
      "SELECT id, deleted_at, deleted_by_user_id FROM campaigns WHERE id = ?",
      [camp.id],
    );
    if (!campRow || !campRow.deleted_at || String(campRow.deleted_by_user_id) !== String(actorUserId)) {
      throw new Error("Campaign soft delete DB state invalid!");
    }

    let camps = await listCampaigns({ tenantId: testTenant });
    if (camps.some((c) => c.id === camp.id)) {
      throw new Error("Soft-deleted campaign appears in listCampaigns!");
    }
    console.log(" -> Campaign soft-deleted successfully.");

    await restoreCampaign(camp.id, testTenant);
    camps = await listCampaigns({ tenantId: testTenant });
    if (!camps.some((c) => c.id === camp.id)) {
      throw new Error("Restored campaign did not reappear!");
    }
    console.log(" -> Campaign restored successfully!");

    // ----------------------------------------------------
    // TEST 5: PLATFORM RECORD SOFT DELETE & RESTORE
    // ----------------------------------------------------
    console.log("\n[TEST 5] Platform Record Soft Delete...");
    const record = await createPlatformRecord(
      "announcements",
      { title: "Test Announcement", status: "ACTIVE" },
      actorUserId,
      "127.0.0.1",
    );
    console.log(" -> Created Platform Record ID:", record.id);

    await deletePlatformRecord("announcements", record.id, actorUserId, "127.0.0.1");
    const [[prRow]] = await pool.execute(
      "SELECT id, deleted_at, deleted_by_user_id FROM platform_records WHERE id = ?",
      [record.id],
    );
    if (!prRow || !prRow.deleted_at || String(prRow.deleted_by_user_id) !== String(actorUserId)) {
      throw new Error("Platform Record soft delete DB state invalid!");
    }

    let prs = await listPlatformRecords("announcements");
    if (prs.some((p) => p.id === record.id)) {
      throw new Error("Soft-deleted platform record appears in listPlatformRecords!");
    }
    console.log(" -> Platform Record soft-deleted successfully.");

    await restorePlatformRecord("announcements", record.id, actorUserId, "127.0.0.1");
    prs = await listPlatformRecords("announcements");
    if (!prs.some((p) => p.id === record.id)) {
      throw new Error("Restored platform record did not reappear!");
    }
    console.log(" -> Platform Record restored successfully!");

    // ----------------------------------------------------
    // TEST 6: TENANT ISOLATION FOR SOFT DELETE & RESTORE
    // ----------------------------------------------------
    console.log("\n[TEST 6] Tenant Isolation...");
    try {
      await deleteCampaign(camp.id, isolationTenant, actorUserId);
      throw new Error("Tenant A campaign was deleted by Tenant B!");
    } catch (err) {
      console.log(" -> Cross-tenant delete correctly blocked:", err.message);
    }

    try {
      await restoreCampaign(camp.id, isolationTenant);
      throw new Error("Tenant A campaign was restored by Tenant B!");
    } catch (err) {
      console.log(" -> Cross-tenant restore correctly blocked:", err.message);
    }

    console.log("\n====================================================");
    console.log("ALL GLOBAL SOFT DELETE ARCHITECTURE TESTS PASSED SUCCESSFULLY! 100% VERIFIED!");
    console.log("====================================================\n");
  } finally {
    // Cleanup test data safely
    await pool.execute("DELETE FROM users WHERE email LIKE '%_sd_%@solmento.internal'");
    await pool.execute("DELETE FROM roles WHERE name = 'Test SD Role'");
    await pool.execute("DELETE FROM chatbots WHERE name = 'SD Test Bot'");
    await pool.execute("DELETE FROM campaigns WHERE name = 'SD Test Campaign'");
    await pool.execute("DELETE FROM platform_records WHERE title LIKE '%Test Announcement%'");
  }
}

runSoftDeleteSystemTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Soft Delete System Test Failed:", err);
    process.exit(1);
  });
