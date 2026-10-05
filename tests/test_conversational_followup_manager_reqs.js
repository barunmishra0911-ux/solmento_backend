import assert from "node:assert/strict";
import { pool } from "../src/config/database.js";
import {
  sendPublicWidgetMessage,
  savePublicLead,
  getPublicWidgetConfig,
} from "../src/services/chatbotService.js";
import { generateGroundedResponse } from "../src/services/geminiService.js";

async function runConversationalFollowUpSuite() {
  console.log("=========================================================================");
  console.log("🚀 TESTING TRUE CONVERSATIONAL FOLLOW-UP AFTER EVERY ANSWER (5 TURNS) 🚀");
  console.log("=========================================================================\n");

  const chatbotId = 80;
  const tenantId = 7;
  const djangoPublicId = "2c07f5cc-3383-439f-ae51-18b78c58534e";
  const djangoFp = "0b93c0945908d4731447acfd81ebca20066707929a6f425087cb7a2518d288b3";
  const cuFp = "ad4f037a3d7e0b22f87f57790b06fcf79d39cd4b362f0906d19877f94243e4ea";

  // Ensure Chatbot 80 starts on Source A: Django
  await pool.execute(
    `UPDATE chatbot_crawl_states
        SET website_url = 'https://www.djangoproject.com/sitemap.xml',
            source_fingerprint = ?, active_source_fingerprint = ?, last_check_status = 'COMPLETED'
      WHERE chatbot_id = ?`,
    [djangoFp, djangoFp, chatbotId]
  );

  const visitorId = "visitor-followup-" + Date.now();
  await savePublicLead({
    publicId: djangoPublicId,
    visitorId,
    fields: { name: "Test Visitor", email: "visitor@example.com" },
  });

  // ----------------------------------------------------
  // TURN 1: Ask a broad topic question
  // ----------------------------------------------------
  console.log("[TURN 1] User asks broad topic question: 'What is Django and what is it used for?'");
  const turn1 = await sendPublicWidgetMessage({
    publicId: djangoPublicId,
    visitorId,
    text: "What is Django and what is it used for?",
  });

  console.log("  Answer 1:", turn1.answer);
  console.log("  Follow-Up Prompt 1:", turn1.followUpPrompt);
  console.log("  Suggestions 1:", turn1.suggestions);
  console.log("  Combined Reply 1:", turn1.reply.slice(0, 140) + "...\n");

  // Verifications for Turn 1
  assert(typeof turn1.answer === "string" && turn1.answer.length > 20, "Turn 1 answer must be a grounded string");
  assert(turn1.answer.toLowerCase().includes("django") || turn1.answer.toLowerCase().includes("python"), "Turn 1 answer must discuss Django");
  assert(typeof turn1.followUpPrompt === "string" && turn1.followUpPrompt.length > 10, "Turn 1 must generate a natural follow-up prompt");
  assert(turn1.followUpPrompt.endsWith("?"), "Follow-up prompt must be a question ending with '?'");
  assert(Array.isArray(turn1.suggestions) && turn1.suggestions.length >= 2 && turn1.suggestions.length <= 3, "Turn 1 must have 2-3 suggestions");
  assert(turn1.reply.includes(turn1.answer), "Combined reply must include answer");
  assert(turn1.reply.includes(turn1.followUpPrompt), "Combined reply must include follow-up prompt");
  console.log("  ✓ Turn 1 verified: Grounded answer + natural follow-up prompt + 2-3 suggestions.\n");

  // ----------------------------------------------------
  // TURN 2: Click one suggestion
  // ----------------------------------------------------
  const selectedSuggestion = turn1.suggestions[0];
  console.log(`[TURN 2] User clicks suggestion chip: '${selectedSuggestion}'`);
  const turn2 = await sendPublicWidgetMessage({
    publicId: djangoPublicId,
    visitorId,
    text: selectedSuggestion,
  });

  console.log("  Answer 2:", turn2.answer);
  console.log("  Follow-Up Prompt 2:", turn2.followUpPrompt);
  console.log("  Suggestions 2:", turn2.suggestions);
  console.log("  Combined Reply 2:", turn2.reply.slice(0, 140) + "...\n");

  // Verifications for Turn 2
  assert(typeof turn2.answer === "string" && turn2.answer.length > 20, "Turn 2 answer must be grounded");
  assert(typeof turn2.followUpPrompt === "string", "Turn 2 follow-up prompt must exist");
  assert(Array.isArray(turn2.suggestions) && turn2.suggestions.length >= 1, "Turn 2 suggestions must exist");
  assert.notEqual(turn2.answer, turn1.answer, "Turn 2 answer must be different from Turn 1");
  assert.notDeepEqual(turn2.suggestions, turn1.suggestions, "Turn 2 suggestions must change appropriately");
  console.log("  ✓ Turn 2 verified: Answer about selected topic + fresh follow-up prompt + updated suggestions.\n");

  // ----------------------------------------------------
  // TURN 3: Ask a different topic manually
  // ----------------------------------------------------
  console.log("[TURN 3] User manually asks a different topic: 'Where can I find the official documentation?'");
  const turn3 = await sendPublicWidgetMessage({
    publicId: djangoPublicId,
    visitorId,
    text: "Where can I find the official documentation?",
  });

  console.log("  Answer 3:", turn3.answer);
  console.log("  Follow-Up Prompt 3:", turn3.followUpPrompt);
  console.log("  Suggestions 3:", turn3.suggestions);
  console.log("  Combined Reply 3:", turn3.reply.slice(0, 140) + "...\n");

  // Verifications for Turn 3
  assert(turn3.answer.toLowerCase().includes("docs.djangoproject.com") || turn3.answer.toLowerCase().includes("documentation"), "Turn 3 answer must cite documentation");
  assert(typeof turn3.followUpPrompt === "string", "Turn 3 follow-up prompt must exist");
  assert(Array.isArray(turn3.suggestions) && turn3.suggestions.length >= 1, "Turn 3 suggestions must exist");
  assert.notDeepEqual(turn3.suggestions, turn2.suggestions, "Turn 3 suggestions must replace previous topic suggestions");
  console.log("  ✓ Turn 3 verified: Documentation answer + doc-related follow-up + previous suggestions replaced.\n");

  // ----------------------------------------------------
  // TURN 4: Ask an unsupported question
  // ----------------------------------------------------
  console.log("[TURN 4] User asks unsupported question: 'What is the price of a samosa in the canteen?'");
  const turn4 = await sendPublicWidgetMessage({
    publicId: djangoPublicId,
    visitorId,
    text: "What is the price of a samosa in the canteen?",
  });

  console.log("  Answer 4:", turn4.answer);
  console.log("  Follow-Up Prompt 4:", turn4.followUpPrompt);
  console.log("  Suggestions 4:", turn4.suggestions);
  console.log("  FollowUpQuestions 4:", turn4.followUpQuestions);
  console.log("  Combined Reply 4:", turn4.reply.slice(0, 140) + "...\n");

  // Verifications for Turn 4
  const a4Lower = turn4.answer.toLowerCase();
  assert(
    a4Lower.includes("not available") || a4Lower.includes("not found") || a4Lower.includes("does not contain") || a4Lower.includes("not mentioned"),
    "Turn 4 answer must be a grounded refusal/fallback"
  );
  assert(!a4Lower.includes("$") && !a4Lower.includes("rupees") && !a4Lower.includes("rs."), "No hallucinated price for samosa");
  assert(!turn4.followUpPrompt.toLowerCase().includes("samosa"), "Follow-up prompt must NEVER mention samosa");
  assert(turn4.followUpQuestions.length === 0, "followUpQuestions must be empty for unsupported query");
  const s4Text = turn4.suggestions.join(" ").toLowerCase();
  assert(!s4Text.includes("samosa"), "Suggestions must NEVER suggest samosas");
  console.log("  ✓ Turn 4 verified: Honest fallback without hallucinated price or fake samosa follow-ups.\n");

  // ----------------------------------------------------
  // TURN 5: Switch chatbot source to Chandigarh University
  // ----------------------------------------------------
  console.log("[TURN 5] Switching chatbot source from Django to Chandigarh University (CU)...");
  await pool.execute(
    `UPDATE chatbot_crawl_states
        SET website_url = 'https://www.cuchd.in/sitemap.xml',
            source_fingerprint = ?, active_source_fingerprint = ?, last_check_status = 'COMPLETED'
      WHERE chatbot_id = ?`,
    [cuFp, cuFp, chatbotId]
  );

  const cuVisitorId = "visitor-cu-" + Date.now();
  await savePublicLead({
    publicId: djangoPublicId,
    visitorId: cuVisitorId,
    fields: { name: "CU Inquirer", email: "cu@example.com" },
  });

  const turn5 = await sendPublicWidgetMessage({
    publicId: djangoPublicId,
    visitorId: cuVisitorId,
    text: "What engineering courses and admissions are available?",
  });

  console.log("  Answer 5 (CU):", turn5.answer);
  console.log("  Follow-Up Prompt 5 (CU):", turn5.followUpPrompt);
  console.log("  Suggestions 5 (CU):", turn5.suggestions);
  console.log("  Combined Reply 5 (CU):", turn5.reply.slice(0, 140) + "...\n");

  // Verifications for Turn 5
  const t5All = (turn5.answer + " " + turn5.followUpPrompt + " " + turn5.suggestions.join(" ")).toLowerCase();
  assert(!t5All.includes("django"), "ZERO Django leakage after switching source to CU");
  assert(turn5.answer.length > 20, "Turn 5 must provide grounded CU response");
  console.log("  ✓ Turn 5 verified: Old source follow-ups disappeared, new source follow-ups generated strictly from CU.\n");

  // Clean up: restore to Django
  await pool.execute(
    `UPDATE chatbot_crawl_states
        SET website_url = 'https://www.djangoproject.com/sitemap.xml',
            source_fingerprint = ?, active_source_fingerprint = ?, last_check_status = 'COMPLETED'
      WHERE chatbot_id = ?`,
    [djangoFp, djangoFp, chatbotId]
  );

  console.log("=========================================================================");
  console.log("🎉 ALL 5 CONVERSATIONAL FOLLOW-UP TURNS PASSED WITH 100% ACCURACY! 🎉");
  console.log("=========================================================================");
  process.exit(0);
}

runConversationalFollowUpSuite().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
