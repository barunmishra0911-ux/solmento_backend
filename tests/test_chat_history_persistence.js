import { pool } from "../src/config/database.js";
import { getPublicWidgetConfig, sendPublicWidgetMessage, savePublicLead } from "../src/services/chatbotService.js";
import { randomUUID } from "node:crypto";

async function runTests() {
  console.log("=== STARTING CHAT HISTORY PERSISTENCE ACCEPTANCE TESTS ===\n");
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (!condition) {
      console.error(`❌ FAIL: ${message}`);
      failed++;
      throw new Error(message);
    } else {
      console.log(`✅ PASS: ${message}`);
      passed++;
    }
  }

  try {
    // 1. Find an active chatbot to test with (specifically chatbot 36 from demo.html if available)
    const [chatbots] = await pool.query(
      "SELECT id, public_id, tenant_id, name FROM chatbots WHERE status = 'ACTIVE' ORDER BY (id = 36) DESC LIMIT 1"
    );
    if (!chatbots.length) {
      throw new Error("No active chatbot found in database.");
    }
    const chatbot = chatbots[0];
    console.log(`Testing with chatbot: "${chatbot.name}" (ID: ${chatbot.id}, Public: ${chatbot.public_id})`);

    const visitorA = `visitor-test-a-${Date.now()}`;
    const visitorB = `visitor-test-b-${Date.now()}`;

    // Test 1: Initial load for Visitor A (no previous conversation)
    console.log("\n--- TEST 1: Initial Widget Load (Visitor A) ---");
    const initConfigA = await getPublicWidgetConfig(chatbot.public_id, visitorA);
    assert(initConfigA.config !== null, "Widget config returned for Visitor A");
    assert(initConfigA.history.length === 0, "No initial history for new visitor");
    assert(initConfigA.conversationId === null, "No conversationId initially");

    // Complete lead capture if mandatory
    if (initConfigA.config.leadCapture?.enabled) {
      console.log("Completing lead capture for Visitor A ('Barun')...");
      const leadPayloadA = {};
      for (const field of initConfigA.config.leadCapture.fields || []) {
        if (field.type === "email") leadPayloadA[field.id] = "barun@test.com";
        else if (field.type === "phone") leadPayloadA[field.id] = "+919876543210";
        else leadPayloadA[field.id] = "Barun";
      }
      await savePublicLead({
        publicId: chatbot.public_id,
        visitorId: visitorA,
        fields: leadPayloadA,
      });
      const leadConfigA = await getPublicWidgetConfig(chatbot.public_id, visitorA);
      assert(leadConfigA.leadCaptured === true, "Lead successfully captured for Visitor A");
    }

    // Test 2: Visitor A sends message 1 ("Hello")
    console.log("\n--- TEST 2: Visitor A sends message 1 ---");
    const msg1Result = await sendPublicWidgetMessage({
      publicId: chatbot.public_id,
      visitorId: visitorA,
      message: "Hello, this is a persistence test message 1",
    });
    assert(typeof msg1Result.reply === "string" && msg1Result.reply.length > 0, "Bot replied to message 1");
    assert(typeof msg1Result.conversationId === "string" && msg1Result.conversationId.length > 0, "ConversationId returned in message 1 response");
    const convIdA = msg1Result.conversationId;
    console.log(`Active conversationId for Visitor A: ${convIdA}`);

    // Verify 1 conversation in DB for Visitor A
    const [convsAfterMsg1] = await pool.query(
      "SELECT id, public_id FROM conversations WHERE tenant_id = ? AND chatbot_id = ? AND visitor_id = ?",
      [chatbot.tenant_id, chatbot.id, visitorA]
    );
    assert(convsAfterMsg1.length === 1, "Exactly 1 conversation record created in DB for Visitor A");
    assert(convsAfterMsg1[0].public_id === convIdA, "DB conversation public_id matches returned conversationId");

    // Test 3: Normal / Hard Page Refresh Simulation
    console.log("\n--- TEST 3: Visitor A refreshes page (reloads widget config with conversationId) ---");
    const refreshConfigA = await getPublicWidgetConfig(chatbot.public_id, visitorA, convIdA);
    assert(refreshConfigA.conversationId === convIdA, "Restored same conversationId on refresh");
    assert(refreshConfigA.history.length >= 2, "Chat history restored on refresh (at least user msg + bot reply)");
    const userMsg1 = refreshConfigA.history.find(m => m.role === "user");
    const botMsg1 = refreshConfigA.history.find(m => m.role === "bot");
    assert(userMsg1 && userMsg1.text.includes("persistence test message 1"), "User message 1 preserved in history");
    assert(botMsg1 && botMsg1.text.length > 0, "Bot reply 1 preserved in history");

    // Test 4: Visitor A sends message 2 inside the same conversation
    console.log("\n--- TEST 4: Visitor A sends message 2 with conversationId ---");
    const msg2Result = await sendPublicWidgetMessage({
      publicId: chatbot.public_id,
      visitorId: visitorA,
      conversationId: convIdA,
      message: "What is React? (persistence test message 2)",
    });
    assert(msg2Result.conversationId === convIdA, "Message 2 stayed in the exact same conversationId");

    // Check DB: MUST STILL BE ONLY 1 CONVERSATION FOR VISITOR A
    const [convsAfterMsg2] = await pool.query(
      "SELECT id, public_id FROM conversations WHERE tenant_id = ? AND chatbot_id = ? AND visitor_id = ?",
      [chatbot.tenant_id, chatbot.id, visitorA]
    );
    assert(convsAfterMsg2.length === 1, "NO duplicate conversation in DB after message 2 (still exactly 1 conversation)");

    // Test 5: Re-refresh page after message 2
    console.log("\n--- TEST 5: Visitor A refreshes page again ---");
    const refresh2ConfigA = await getPublicWidgetConfig(chatbot.public_id, visitorA, convIdA);
    assert(refresh2ConfigA.conversationId === convIdA, "Restored same conversationId on 2nd refresh");
    assert(refresh2ConfigA.history.length >= 4, "Chat history contains all 4 messages (2 user + 2 bot)");
    // Check chronological order
    const msgs = refresh2ConfigA.history;
    assert(msgs[0].role === "user" && msgs[0].text.includes("message 1"), "First message is user message 1");
    assert(msgs[msgs.length - 2].role === "user" && msgs[msgs.length - 2].text.includes("message 2"), "Second user message is message 2");

    // Test 6: Visitor B Isolation Test
    console.log("\n--- TEST 6: Visitor B Isolation Test (different visitor cannot access Visitor A's conversation) ---");
    // Visitor B attempts to pass Visitor A's conversationId
    const hackedConfigB = await getPublicWidgetConfig(chatbot.public_id, visitorB, convIdA);
    assert(hackedConfigB.history.length === 0, "Visitor B CANNOT see Visitor A's chat history");
    assert(hackedConfigB.conversationId === null, "Visitor A's conversationId NOT assigned to Visitor B");

    // Visitor B completes lead capture if mandatory
    if (initConfigA.config.leadCapture?.enabled) {
      const leadPayloadB = {};
      for (const field of initConfigA.config.leadCapture.fields || []) {
        if (field.type === "email") leadPayloadB[field.id] = "visitorb@test.com";
        else if (field.type === "phone") leadPayloadB[field.id] = "+919876543219";
        else leadPayloadB[field.id] = "VisitorB";
      }
      await savePublicLead({
        publicId: chatbot.public_id,
        visitorId: visitorB,
        fields: leadPayloadB,
      });
    }

    // Visitor B sends a message
    const msgBResult = await sendPublicWidgetMessage({
      publicId: chatbot.public_id,
      visitorId: visitorB,
      message: "Hello from Visitor B",
    });
    const convIdB = msgBResult.conversationId;
    assert(convIdB !== convIdA, "Visitor B received a completely distinct conversationId");

    // Test 7: Multiple Chatbots Isolation Test
    console.log("\n--- TEST 7: Multiple Chatbots Isolation Test ---");
    const [otherChatbots] = await pool.query(
      "SELECT id, public_id, tenant_id, name FROM chatbots WHERE status = 'ACTIVE' AND id != ? LIMIT 1",
      [chatbot.id]
    );
    if (otherChatbots.length > 0) {
      const otherChatbot = otherChatbots[0];
      console.log(`Checking cross-chatbot isolation with chatbot: "${otherChatbot.name}" (ID: ${otherChatbot.id})`);
      const crossBotConfig = await getPublicWidgetConfig(otherChatbot.public_id, visitorA, convIdA);
      assert(crossBotConfig.history.length === 0, "Chatbot B CANNOT load conversation belonging to Chatbot A");
      assert(crossBotConfig.conversationId === null, "Chatbot A conversationId rejected by Chatbot B");
    } else {
      console.log("Only 1 published chatbot in DB, skipping multi-chatbot query check (verified via tenant_id and chatbot_id WHERE clauses in code).");
    }

    // Clean up test data
    console.log("\n--- Cleaning up test records ---");
    await pool.query(
      "DELETE FROM conversation_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE visitor_id IN (?, ?))",
      [visitorA, visitorB]
    );
    await pool.query(
      "DELETE FROM conversations WHERE visitor_id IN (?, ?)",
      [visitorA, visitorB]
    );
    await pool.query(
      "DELETE FROM leads WHERE visitor_id IN (?, ?)",
      [visitorA, visitorB]
    );
    console.log("Test records cleaned up successfully.");

    console.log(`\n========================================`);
    console.log(`RESULTS: ${passed} passed, ${failed} failed.`);
    console.log(`========================================`);
  } catch (err) {
    console.error("Test run error:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runTests();
