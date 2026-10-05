import assert from "node:assert/strict";
import { pool } from "../src/config/database.js";
import { sendPublicWidgetMessage, getPublicWidgetConfig, savePublicLead } from "../src/services/chatbotService.js";

async function runAcceptanceTests() {
  console.log("=== RUNNING ACCEPTANCE TESTS FOR CONTEXTUAL SUGGESTIONS ===");

  // Public ID for chatbot 36
  const [[bot]] = await pool.query("SELECT public_id FROM chatbots WHERE id = 36");
  const publicId = bot.public_id;
  const visitorId = "test-visitor-" + Date.now();

  console.log(`Using Chatbot 36 (publicId: ${publicId})`);

  // 0. Verify initial widget config has NO Django and has sourceGenerationId
  const initialCfg = await getPublicWidgetConfig(publicId, visitorId);
  console.log("Initial sourceGenerationId:", initialCfg.sourceGenerationId);
  console.log("Initial welcome suggestedQuestions:", initialCfg.config?.suggestedQuestions?.map(q => typeof q === 'string' ? q : q.text));
  const initQuestionsStr = JSON.stringify(initialCfg.config?.suggestedQuestions || []).toLowerCase();
  assert.equal(initQuestionsStr.includes("django"), false, "Welcome suggestions must not contain Django");
  assert.equal(initialCfg.sourceGenerationId, "3dc86e6666d7a5f236ea594bf10bb95726c2fa7538d7e755dc766aa1561e2feb");

  // Submit lead so chat is authorized
  const leadFields = {};
  for (const f of initialCfg.config?.leadCapture?.fields || []) {
    leadFields[f.id] = f.type === "email" ? "test@example.com" : f.type === "phone" ? "+919876543210" : "Test Visitor";
  }
  await savePublicLead({ publicId, visitorId, fields: leadFields });
  console.log("Lead captured for test visitor.");

  // TEST 1: Out-of-scope question ("What is the price of idli?")
  console.log("\n--- TEST 1: Out-of-scope ('What is the price of idli?') ---");
  const res1 = await sendPublicWidgetMessage({
    publicId,
    visitorId,
    message: "What is the price of idli?",
  });
  console.log("Reply:", res1.reply);
  console.log("Follow-up Prompt:", res1.followUpPrompt);
  console.log("Suggestions:", res1.suggestions);
  console.log("sourceGenerationId:", res1.sourceGenerationId);

  const res1Str = JSON.stringify(res1).toLowerCase();
  assert.equal(res1Str.includes("django"), false, "TEST 1: Must contain ZERO Django");
  assert.equal(res1.suggestions.length > 0, true, "TEST 1: Suggestions must not be empty");
  assert.equal(res1.suggestions.every(s => typeof s === "string"), true, "TEST 1: All suggestions must be strings");
  assert.equal(res1.sourceGenerationId, "3dc86e6666d7a5f236ea594bf10bb95726c2fa7538d7e755dc766aa1561e2feb");
  assert.equal(
    /not available|not found|could not find|doesn't contain/i.test(res1.answer),
    true,
    "TEST 1: Answer must state idli price is not available"
  );
  console.log("✓ TEST 1 PASSED");

  // TEST 2: In-scope question ("What is lifting state up in React?")
  console.log("\n--- TEST 2: In-scope ('What is lifting state up in React?') ---");
  const res2 = await sendPublicWidgetMessage({
    publicId,
    visitorId,
    message: "What is lifting state up in React?",
  });
  console.log("Reply:", res2.reply);
  console.log("Follow-up Prompt:", res2.followUpPrompt);
  console.log("Suggestions:", res2.suggestions);

  const res2Str = JSON.stringify(res2).toLowerCase();
  assert.equal(res2Str.includes("django"), false, "TEST 2: Must contain ZERO Django");
  assert.equal(res2.suggestions.length > 0, true, "TEST 2: Suggestions must not be empty");
  assert.equal(
    /state|component|share|parent|prop/i.test(res2.answer),
    true,
    "TEST 2: Answer must discuss React state/components"
  );
  console.log("✓ TEST 2 PASSED");

  // TEST 3: In-scope question ("What are React components?")
  console.log("\n--- TEST 3: In-scope ('What are React components?') ---");
  const res3 = await sendPublicWidgetMessage({
    publicId,
    visitorId,
    message: "What are React components?",
  });
  console.log("Reply:", res3.reply);
  console.log("Follow-up Prompt:", res3.followUpPrompt);
  console.log("Suggestions:", res3.suggestions);

  const res3Str = JSON.stringify(res3).toLowerCase();
  assert.equal(res3Str.includes("django"), false, "TEST 3: Must contain ZERO Django");
  assert.equal(res3.suggestions.length > 0, true, "TEST 3: Suggestions must not be empty");
  assert.equal(
    /component|ui|javascript|function/i.test(res3.answer),
    true,
    "TEST 3: Answer must explain components"
  );
  console.log("✓ TEST 3 PASSED");

  // TEST 4: In-scope question ("What is useState?")
  console.log("\n--- TEST 4: In-scope ('What is useState?') ---");
  const res4 = await sendPublicWidgetMessage({
    publicId,
    visitorId,
    message: "What is useState?",
  });
  console.log("Reply:", res4.reply);
  console.log("Follow-up Prompt:", res4.followUpPrompt);
  console.log("Suggestions:", res4.suggestions);

  const res4Str = JSON.stringify(res4).toLowerCase();
  assert.equal(res4Str.includes("django"), false, "TEST 4: Must contain ZERO Django");
  assert.equal(res4.suggestions.length > 0, true, "TEST 4: Suggestions must not be empty");
  assert.equal(
    /state|hook|variable/i.test(res4.answer),
    true,
    "TEST 4: Answer must discuss useState"
  );
  console.log("✓ TEST 4 PASSED");

  // TEST 5: Multi-concept question ("What is useState and useEffect?")
  console.log("\n--- TEST 5: Multi-concept ('What is useState and useEffect?') ---");
  const res5 = await sendPublicWidgetMessage({
    publicId,
    visitorId,
    message: "What is useState and useEffect?",
  });
  console.log("Reply:", res5.reply);
  console.log("Follow-up Prompt:", res5.followUpPrompt);
  console.log("Suggestions:", res5.suggestions);

  const res5Str = JSON.stringify(res5).toLowerCase();
  assert.equal(res5Str.includes("django"), false, "TEST 5: Must contain ZERO Django");
  assert.equal(res5.suggestions.length > 0, true, "TEST 5: Suggestions must not be empty");
  console.log("✓ TEST 5 PASSED");

  // TEST 6: Out-of-scope question ("Who is Barun?")
  console.log("\n--- TEST 6: Out-of-scope ('Who is Barun?') ---");
  const res6 = await sendPublicWidgetMessage({
    publicId,
    visitorId,
    message: "Who is Barun?",
  });
  console.log("Reply:", res6.reply);
  console.log("Follow-up Prompt:", res6.followUpPrompt);
  console.log("Suggestions:", res6.suggestions);

  const res6Str = JSON.stringify(res6).toLowerCase();
  assert.equal(res6Str.includes("django"), false, "TEST 6: Must contain ZERO Django");
  assert.equal(res6.suggestions.length > 0, true, "TEST 6: Suggestions must not be empty");
  assert.equal(
    /not available|not found|could not find|doesn't contain/i.test(res6.answer),
    true,
    "TEST 6: Answer must state information about Barun is not available"
  );
  console.log("✓ TEST 6 PASSED");

  // TEST 7: Out-of-scope question ("What is the price of samosa?")
  console.log("\n--- TEST 7: Out-of-scope ('What is the price of samosa?') ---");
  const res7 = await sendPublicWidgetMessage({
    publicId,
    visitorId,
    message: "What is the price of samosa?",
  });
  console.log("Reply:", res7.reply);
  console.log("Follow-up Prompt:", res7.followUpPrompt);
  console.log("Suggestions:", res7.suggestions);

  const res7Str = JSON.stringify(res7).toLowerCase();
  assert.equal(res7Str.includes("django"), false, "TEST 7: Must contain ZERO Django");
  assert.equal(res7.suggestions.length > 0, true, "TEST 7: Suggestions must not be empty");
  assert.equal(
    /not available|not found|could not find|doesn't contain/i.test(res7.answer),
    true,
    "TEST 7: Answer must state samosa price is not available"
  );
  console.log("✓ TEST 7 PASSED");

  console.log("\n=========================================");
  console.log("ALL 7 ACCEPTANCE TESTS PASSED SUCCESSFULLY!");
  console.log("=========================================");
  process.exit(0);
}

runAcceptanceTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
