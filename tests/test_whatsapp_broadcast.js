import { pool } from "../src/config/database.js";
import {
  sendWhatsAppMessage,
  getWhatsAppLeads,
  getWhatsAppBroadcasts,
} from "../src/services/whatsappService.js";

async function runBroadcastTests() {
  console.log("=== STARTING WHATSAPP MULTI-RECIPIENT BROADCAST TEST SUITE ===");
  let passed = 0;
  let failed = 0;

  function assert(cond, msg) {
    if (cond) {
      console.log(`  ✓ PASS: ${msg}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${msg}`);
      failed++;
    }
  }

  try {
    // 1. Setup mock tenant & WhatsApp config in DB for isolated testing
    const testTenantId = 99999;
    await pool.execute("DELETE FROM whatsapp_message_logs WHERE tenant_id = ?", [testTenantId]);
    await pool.execute("DELETE FROM whatsapp_broadcasts WHERE tenant_id = ?", [testTenantId]);
    await pool.execute("DELETE FROM leads WHERE tenant_id = ?", [testTenantId]);
    await pool.execute("DELETE FROM whatsapp_configs WHERE tenant_id = ?", [testTenantId]);
    await pool.execute("DELETE FROM chatbots WHERE tenant_id = ?", [testTenantId]);
    await pool.execute("DELETE FROM tenants WHERE id = ?", [testTenantId]);

    await pool.execute(
      "INSERT INTO tenants (id, name, company_name, slug) VALUES (?, 'Test Broadcast Tenant', 'Test Company', 'test-broadcast-tenant')",
      [testTenantId]
    );

    await pool.execute(
      `INSERT INTO whatsapp_configs
        (tenant_id, business_name, phone_number, phone_number_id, waba_id, access_token, webhook_verify_token, status)
       VALUES (?, 'Test Business', '+1 555-165-4987', '1269538182917342', 'waba_test', 'mock_token', 'verify_test', 'CONNECTED')`,
      [testTenantId]
    );

    await pool.execute("DELETE FROM chatbots WHERE tenant_id = ?", [testTenantId]);
    const [botRes] = await pool.execute(
      "INSERT INTO chatbots (public_id, tenant_id, name, description, channels_json, config_json, published_config_json, status) VALUES ('test_bot_uuid', ?, 'Test Bot', 'Test Description', '[\"whatsapp\"]', '{}', '{}', 'ACTIVE')",
      [testTenantId]
    );
    const testBotId = botRes.insertId;

    // 2. Insert test leads (including 1 soft-deleted lead and 1 lead with invalid phone)
    const [lead1Res] = await pool.execute(
      `INSERT INTO leads (public_id, tenant_id, chatbot_id, chatbot_public_id, visitor_id, source, fields_json, status, deleted_at)
       VALUES ('lead_1_uuid', ?, ?, 'test_bot_uuid', 'v1', 'whatsapp', '{"name":"Lead One","phone":"9319993292"}', 'NEW', NULL)`,
      [testTenantId, testBotId]
    );
    const lead1Id = lead1Res.insertId;

    const [lead2Res] = await pool.execute(
      `INSERT INTO leads (public_id, tenant_id, chatbot_id, chatbot_public_id, visitor_id, source, fields_json, status, deleted_at)
       VALUES ('lead_2_uuid', ?, ?, 'test_bot_uuid', 'v2', 'whatsapp', '{"name":"Lead Two","phone":"6205001632"}', 'NEW', NULL)`,
      [testTenantId, testBotId]
    );
    const lead2Id = lead2Res.insertId;

    const [lead3Res] = await pool.execute(
      `INSERT INTO leads (public_id, tenant_id, chatbot_id, chatbot_public_id, visitor_id, source, fields_json, status, deleted_at)
       VALUES ('lead_3_uuid', ?, ?, 'test_bot_uuid', 'v3', 'whatsapp', '{"name":"Lead Three","phone":"9911808486"}', 'NEW', NULL)`,
      [testTenantId, testBotId]
    );
    const lead3Id = lead3Res.insertId;

    const [lead4Res] = await pool.execute(
      `INSERT INTO leads (public_id, tenant_id, chatbot_id, chatbot_public_id, visitor_id, source, fields_json, status, deleted_at)
       VALUES ('lead_4_uuid', ?, ?, 'test_bot_uuid', 'v4', 'whatsapp', '{"name":"Lead Four","phone":"9024315882"}', 'NEW', NULL)`,
      [testTenantId, testBotId]
    );
    const lead4Id = lead4Res.insertId;

    const [lead5Res] = await pool.execute(
      `INSERT INTO leads (public_id, tenant_id, chatbot_id, chatbot_public_id, visitor_id, source, fields_json, status, deleted_at)
       VALUES ('lead_5_uuid', ?, ?, 'test_bot_uuid', 'v5', 'whatsapp', '{"name":"Lead Five","phone":"9151017315"}', 'NEW', NULL)`,
      [testTenantId, testBotId]
    );
    const lead5Id = lead5Res.insertId;

    // Soft-deleted lead
    const [deletedLeadRes] = await pool.execute(
      `INSERT INTO leads (public_id, tenant_id, chatbot_id, chatbot_public_id, visitor_id, source, fields_json, status, deleted_at)
       VALUES ('lead_del_uuid', ?, ?, 'test_bot_uuid', 'vdel', 'whatsapp', '{"name":"Deleted Lead","phone":"9888888888"}', 'NEW', NOW())`,
      [testTenantId, testBotId]
    );
    const deletedLeadId = deletedLeadRes.insertId;

    // Lead without phone
    const [noPhoneLeadRes] = await pool.execute(
      `INSERT INTO leads (public_id, tenant_id, chatbot_id, chatbot_public_id, visitor_id, source, fields_json, status, deleted_at)
       VALUES ('lead_nophone_uuid', ?, ?, 'test_bot_uuid', 'vnophone', 'whatsapp', '{"name":"No Phone Lead","phone":""}', 'NEW', NULL)`,
      [testTenantId, testBotId]
    );
    const noPhoneLeadId = noPhoneLeadRes.insertId;

    console.log("\n--- TEST 1: Verify getWhatsAppLeads respects soft-delete ---");
    const activeLeads = await getWhatsAppLeads(testTenantId);
    assert(activeLeads.length === 6, `Active leads count should be 6 (found ${activeLeads.length})`);
    assert(!activeLeads.some(l => l.id === deletedLeadId), "Soft-deleted lead is excluded from active leads");
    assert(activeLeads.find(l => l.id === noPhoneLeadId).hasValidPhone === false, "Lead with no phone marked as hasValidPhone: false");

    console.log("\n--- TEST 2: Send Single Recipient (Case A: 1 recipient) ---");
    const resSingle = await sendWhatsAppMessage(testTenantId, 1, {
      messageText: "Test Single Send",
      recipientMode: "SELECTED",
      leadIds: [lead1Id],
    });
    assert(resSingle.totalRecipients === 1, `Total recipients is 1 (found ${resSingle.totalRecipients})`);
    assert(resSingle.recipients.length === 1, `Recipient logs length is 1 (found ${resSingle.recipients.length})`);
    assert(resSingle.sentCount + resSingle.failedCount === 1, "Sum of sent + failed equals total");

    console.log("\n--- TEST 3: Send Multi-Recipient (Case B: 2 recipients) ---");
    const resTwo = await sendWhatsAppMessage(testTenantId, 1, {
      messageText: "Test Two Recipients",
      recipientMode: "SELECTED",
      leadIds: [lead1Id, lead2Id],
    });
    assert(resTwo.totalRecipients === 2, `Total recipients is 2 (found ${resTwo.totalRecipients})`);
    assert(resTwo.recipients.length === 2, `Both recipients attempted (found ${resTwo.recipients.length})`);
    assert(resTwo.sentCount + resTwo.failedCount === 2, "Sum of sent + failed equals 2");

    console.log("\n--- TEST 4: Send Multi-Recipient (Case C: 5 recipients) ---");
    const resFive = await sendWhatsAppMessage(testTenantId, 1, {
      messageText: "Test Five Recipients",
      recipientMode: "SELECTED",
      leadIds: [lead1Id, lead2Id, lead3Id, lead4Id, lead5Id],
    });
    assert(resFive.totalRecipients === 5, `Total recipients is 5 (found ${resFive.totalRecipients})`);
    assert(resFive.recipients.length === 5, `All 5 recipients attempted independently (found ${resFive.recipients.length})`);
    assert(resFive.sentCount + resFive.failedCount === 5, "Sum of sent + failed equals 5");

    console.log("\n--- TEST 5: Verify Broadcasts History & Persistence ---");
    const history = await getWhatsAppBroadcasts(testTenantId, 10);
    assert(history.length === 3, `Broadcasts history contains 3 broadcasts (found ${history.length})`);
    const fiveBroadcast = history.find(b => b.id === resFive.broadcastId);
    assert(Boolean(fiveBroadcast), "Broadcast #5 exists in history");
    assert(fiveBroadcast.totalRecipients === 5, `Broadcast history records total 5 (found ${fiveBroadcast.totalRecipients})`);
    assert(fiveBroadcast.recipients.length === 5, `Broadcast history contains all 5 recipient logs (found ${fiveBroadcast.recipients.length})`);

    // Cleanup
    await pool.execute("DELETE FROM whatsapp_message_logs WHERE tenant_id = ?", [testTenantId]);
    await pool.execute("DELETE FROM whatsapp_broadcasts WHERE tenant_id = ?", [testTenantId]);
    await pool.execute("DELETE FROM leads WHERE tenant_id = ?", [testTenantId]);
    await pool.execute("DELETE FROM whatsapp_configs WHERE tenant_id = ?", [testTenantId]);
    await pool.execute("DELETE FROM chatbots WHERE tenant_id = ?", [testTenantId]);
    await pool.execute("DELETE FROM tenants WHERE id = ?", [testTenantId]);

    console.log(`\n=== RESULTS: ${passed} PASSED, ${failed} FAILED ===`);
    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (error) {
    console.error("Test Suite Unhandled Exception:", error);
    process.exit(1);
  }
}

runBroadcastTests();
