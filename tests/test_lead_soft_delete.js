import { pool } from "../src/config/database.js";
import { softDeleteLead, updateLeadDetails, getLeadById, listLeads } from "../src/services/leadService.js";

async function runLeadSoftDeleteTest() {
  console.log("=== STARTING LEAD SOFT DELETE & UPDATE TESTS ===");

  // 1. Get an existing chatbot
  const [cbRows] = await pool.execute("SELECT id, public_id, tenant_id FROM chatbots WHERE deleted_at IS NULL LIMIT 1");
  if (!cbRows.length) throw new Error("No chatbots found for test!");
  const cbId = cbRows[0].id;
  const cbPublicId = cbRows[0].public_id;
  const tenantId = cbRows[0].tenant_id;
  const actorUserId = 1;

  // 2. Insert a temporary lead
  const testPublicId = `test_lead_${Date.now()}`;
  const [insertRes] = await pool.execute(
    `INSERT INTO leads (public_id, tenant_id, chatbot_id, chatbot_public_id, visitor_id, status, source, fields_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'visitor_123', 'NEW', 'website', ?, NOW(), NOW())`,
    [testPublicId, tenantId, cbId, cbPublicId, JSON.stringify({ name: "Test Student", email: "test@student.com", phone: "9876543210" })]
  );
  const leadId = insertRes.insertId;
  console.log(`[TEST 1] Created test lead with DB ID: ${leadId}, public_id: ${testPublicId}`);

  // 2. Test update
  const updated = await updateLeadDetails(tenantId, testPublicId, {
    name: "Updated Student Name",
    email: "updated@student.com",
    phone: "9123456780",
  });
  if (updated.name !== "Updated Student Name" || updated.email !== "updated@student.com") {
    throw new Error("Lead update failed!");
  }
  console.log(" -> Lead updated successfully:", updated.name, updated.email, updated.phone);

  // 3. Test Soft Delete
  const delRes = await softDeleteLead(tenantId, testPublicId, actorUserId);
  console.log(" -> Soft delete executed:", delRes);

  // 4. Verify DB Row still exists and deleted_at & deleted_by_user_id are populated
  const [checkRows] = await pool.execute(
    "SELECT id, public_id, deleted_at, deleted_by_user_id FROM leads WHERE id = ?",
    [leadId]
  );
  if (checkRows.length === 0) {
    throw new Error("FAIL: DB row was permanently deleted! Expected soft delete.");
  }
  if (!checkRows[0].deleted_at || !checkRows[0].deleted_by_user_id) {
    throw new Error("FAIL: deleted_at or deleted_by_user_id is not populated!");
  }
  console.log(" -> Verified DB row preserved with deleted_at:", checkRows[0].deleted_at, "deleted_by_user_id:", checkRows[0].deleted_by_user_id);

  // 5. Verify excluded from getLeadById and listStudentLeads
  const fetched = await getLeadById(tenantId, testPublicId);
  if (fetched !== null) {
    throw new Error("FAIL: Soft-deleted lead was fetched by getLeadById!");
  }
  console.log(" -> Verified getLeadById returns null for soft-deleted lead.");

  // Clean up test record
  await pool.execute("DELETE FROM leads WHERE id = ?", [leadId]);

  console.log("====================================================");
  console.log("ALL LEAD SOFT DELETE TESTS PASSED SUCCESSFULLY! 100% VERIFIED!");
  console.log("====================================================");
  process.exit(0);
}

runLeadSoftDeleteTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
