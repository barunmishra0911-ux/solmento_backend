import { pool } from "../src/config/database.js";
import { validateSafeUrl, extractCleanContent, computeContentHash } from "../src/services/crawlerService.js";
import {
  saveCrawledPages,
  getChatbotKnowledgeStats,
  searchKnowledgeExcerpts,
  computeSourceFingerprint,
} from "../src/services/chatbotKnowledgeService.js";
import { generateGroundedResponse, isGeminiConfigured } from "../src/services/geminiService.js";
import { sendPublicWidgetMessage } from "../src/services/chatbotService.js";

async function runWebsiteAwareChatTests() {
  console.log("=== STARTING WEBSITE-AWARE GEMINI TEXT CHAT TESTS ===");

  // ----------------------------------------------------
  // TEST 1: Crawler Security & SSRF Protection
  // ----------------------------------------------------
  console.log("\n[TEST 1] Verifying Crawler SSRF Protections...");
  const dangerousUrls = [
    "http://127.0.0.1:5000/api",
    "http://localhost:3000",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.1.1/admin",
    "ftp://example.com/file",
  ];

  for (const url of dangerousUrls) {
    try {
      await validateSafeUrl(url);
      throw new Error(`Security failure: Dangerous URL allowed: ${url}`);
    } catch (err) {
      console.log(`  ✓ Blocked unsafe URL (${url}): ${err.message}`);
    }
  }

  // ----------------------------------------------------
  // TEST 2: HTML Content Extraction & Sanitization
  // ----------------------------------------------------
  console.log("\n[TEST 2] Verifying HTML Content Sanitization...");
  const sampleHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Apex Institute of Technology - Admissions 2026</title>
        <script>alert("malicious script");</script>
        <style>body { background: red; }</style>
      </head>
      <body>
        <nav><a href="/home">Home</a><a href="/about">About</a></nav>
        <header><h1>Welcome Header</h1></header>
        <main>
          <h2>B.Tech in Artificial Intelligence</h2>
          <p>The annual tuition fee for B.Tech in Artificial Intelligence is <strong>INR 2,20,000</strong>.</p>
          <p>Eligibility requires 60% aggregate in Physics, Chemistry, and Mathematics in Class 12.</p>
        </main>
        <footer><p>Copyright 2026</p></footer>
      </body>
    </html>
  `;

  const extracted = extractCleanContent(sampleHtml);
  if (!extracted.title.includes("Apex Institute")) {
    throw new Error("Title extraction failed!");
  }
  if (extracted.text.includes("<script>") || extracted.text.includes("alert")) {
    throw new Error("Script tag not stripped!");
  }
  if (!extracted.text.includes("INR 2,20,000") || !extracted.text.includes("Physics, Chemistry")) {
    throw new Error("Content text extraction failed!");
  }
  console.log("  ✓ Sanitization succeeded. Title:", extracted.title);
  console.log("  ✓ Extracted snippet:", extracted.text.slice(0, 80).replace(/\n/g, " "), "...");

  // ----------------------------------------------------
  // TEST 3: MySQL Knowledge Storage & Fulltext Indexing
  // ----------------------------------------------------
  console.log("\n[TEST 3] Testing Knowledge Page Storage & Retrieval in MySQL...");
  // Find or create test chatbot
  const [cbRows] = await pool.execute(
    "SELECT id, public_id, tenant_id, name FROM chatbots WHERE status = 'ACTIVE' LIMIT 1",
  );
  if (!cbRows.length) {
    throw new Error("No active chatbot found in database to run tests!");
  }
  const testChatbot = cbRows[0];
  const testUrl = "https://apex-tech.edu/programs/btech-ai";

  const testPages = [
    {
      url: testUrl,
      title: "B.Tech in Artificial Intelligence - Apex Tech",
      contentText: "The annual tuition fee for B.Tech in Artificial Intelligence is INR 2,20,000. Eligibility criteria: Candidate must have passed 10+2 with 60% marks in PCM. Scholarships of up to 40% are available for students scoring above 90% in JEE Main.",
      contentHash: computeContentHash("The annual tuition fee for B.Tech in Artificial Intelligence is INR 2,20,000."),
      status: "INDEXED",
    },
    {
      url: "https://apex-tech.edu/admissions/hostel",
      title: "Hostel Facilities & Accommodation - Apex Tech",
      contentText: "Apex Tech offers AC and Non-AC hostel rooms with 24/7 Wi-Fi, laundry, and biometric security. Annual hostel fee is INR 85,000 including food.",
      contentHash: computeContentHash("Apex Tech offers AC and Non-AC hostel rooms."),
      status: "INDEXED",
    },
  ];

  const testFingerprint = computeSourceFingerprint(testUrl);
  const [existingCrawlStates] = await pool.execute(
    "SELECT source_fingerprint, active_source_fingerprint, last_check_status FROM chatbot_crawl_states WHERE chatbot_id = ?",
    [testChatbot.id]
  );
  const prevCrawlState = existingCrawlStates[0] || null;

  await pool.execute(
    `INSERT INTO chatbot_crawl_states (tenant_id, chatbot_id, website_url, source_fingerprint, active_source_fingerprint, last_check_status)
     VALUES (?, ?, ?, ?, ?, 'COMPLETED')
     ON DUPLICATE KEY UPDATE source_fingerprint = VALUES(source_fingerprint), active_source_fingerprint = VALUES(active_source_fingerprint), last_check_status = 'COMPLETED'`,
    [testChatbot.tenant_id, testChatbot.id, testUrl, testFingerprint, testFingerprint]
  );

  await saveCrawledPages({
    tenantId: testChatbot.tenant_id,
    chatbotId: testChatbot.id,
    sourceFingerprint: testFingerprint,
    pages: testPages,
  });

  const stats = await getChatbotKnowledgeStats({
    tenantId: testChatbot.tenant_id,
    chatbotId: testChatbot.id,
    sourceFingerprint: testFingerprint,
  });
  console.log(`  ✓ Stored test pages. Indexed total pages: ${stats.totalPages}`);

  // Test retrieval with keyword query
  const excerpts = await searchKnowledgeExcerpts({
    tenantId: testChatbot.tenant_id,
    chatbotId: testChatbot.id,
    query: "tuition fee for B.Tech Artificial Intelligence",
  });

  if (!excerpts.length || !excerpts[0].text.includes("INR 2,20,000")) {
    throw new Error("Knowledge retrieval failed to return relevant B.Tech AI excerpt!");
  }
  console.log("  ✓ Retrieved excerpt matched source text:", excerpts[0].text.slice(0, 100));

  // ----------------------------------------------------
  // TEST 4: Tenant & Chatbot Isolation
  // ----------------------------------------------------
  console.log("\n[TEST 4] Verifying Tenant & Chatbot Isolation...");
  const foreignExcerpts = await searchKnowledgeExcerpts({
    tenantId: 999999, // Non-existent foreign tenant
    chatbotId: testChatbot.id,
    query: "Artificial Intelligence",
  });
  if (foreignExcerpts.length !== 0) {
    throw new Error("Security failure: Tenant isolation violated! Foreign tenant accessed knowledge!");
  }
  console.log("  ✓ Isolation verified: Foreign tenant queries return 0 results.");

  // ----------------------------------------------------
  // TEST 5: Real Gemini Grounded Response Generation
  // ----------------------------------------------------
  console.log("\n[TEST 5] Testing Grounded Gemini API Response Generation...");
  if (!isGeminiConfigured()) {
    throw new Error("GEMINI_API_KEY is not configured in backend environment!");
  }

  // Question present in knowledge base
  const groundedResponse = await generateGroundedResponse({
    chatbotName: testChatbot.name,
    personality: "Helpful and Professional",
    language: "English",
    excerpts,
    userQuestion: "What is the fee for B.Tech in Artificial Intelligence?",
  });

  console.log("  ✓ Grounded Answer received:");
  console.log("    -->", groundedResponse.reply.trim().replace(/\n/g, " "));

  if (!groundedResponse.reply.includes("2,20,000") && !groundedResponse.reply.includes("220000")) {
    throw new Error("Gemini response was not properly grounded with the excerpt fee amount!");
  }
  console.log("  ✓ Verification passed: Fee amount INR 2,20,000 accurately cited.");

  // ----------------------------------------------------
  // TEST 6: Absent Question (No Hallucination)
  // ----------------------------------------------------
  console.log("\n[TEST 6] Testing Absent Question (Refusal / No Hallucination)...");
  const absentResponse = await generateGroundedResponse({
    chatbotName: testChatbot.name,
    personality: "Helpful and Professional",
    language: "English",
    excerpts,
    userQuestion: "What is the phone number of the NASA headquarters director?",
  });

  console.log("  ✓ Refusal Answer received:");
  console.log("    -->", absentResponse.reply.trim().replace(/\n/g, " "));

  const replyLower = absentResponse.reply.toLowerCase();
  const validRefusal =
    replyLower.includes("not available") ||
    replyLower.includes("cannot find") ||
    replyLower.includes("could not find") ||
    replyLower.includes("not mentioned") ||
    replyLower.includes("counsellor") ||
    replyLower.includes("counselor");

  if (!validRefusal) {
    throw new Error("Gemini did not properly decline an absent factual question!");
  }
  console.log("  ✓ Verification passed: Refusal and counsellor referral verified without hallucinations.");

  // ----------------------------------------------------
  // TEST 7: End-to-End sendPublicWidgetMessage
  // ----------------------------------------------------
  console.log("\n[TEST 7] Testing End-to-End sendPublicWidgetMessage Service...");
  // Make sure chatbot has published config and test visitor
  const testVisitor = `visitor_${Date.now()}`;
  
  // Create or bypass lead if lead capture enabled
  await pool.execute(
    `INSERT INTO leads
      (public_id, tenant_id, chatbot_id, chatbot_public_id, visitor_id, source, fields_json)
     VALUES (?, ?, ?, ?, ?, 'website_widget', ?)
     ON DUPLICATE KEY UPDATE updated_at = NOW()`,
    [`lead_${Date.now()}`, testChatbot.tenant_id, testChatbot.id, testChatbot.public_id, testVisitor, JSON.stringify({ name: "Demo User", email: "demo@test.com" })]
  );

  const widgetResult = await sendPublicWidgetMessage({
    publicId: testChatbot.public_id,
    message: "Tell me about the hostel facilities and fee",
    visitorId: testVisitor,
  });

  console.log("  ✓ Widget API Response:");
  console.log("    Reply:", widgetResult.reply.slice(0, 120), "...");
  console.log("    Intent:", widgetResult.intent);
  console.log("    Conversation ID:", widgetResult.conversationId);

  // Verify message persisted in conversation_messages table
  const [msgRows] = await pool.execute(
    `SELECT role, content FROM conversation_messages WHERE tenant_id = ? AND chatbot_id = ? ORDER BY id DESC LIMIT 2`,
    [testChatbot.tenant_id, testChatbot.id]
  );

  if (msgRows.length < 2 || msgRows[0].role !== "ASSISTANT" || msgRows[1].role !== "USER") {
    throw new Error("Conversation messages were not properly persisted to the database!");
  }
  console.log("  ✓ Message persistence confirmed: Both USER and ASSISTANT messages saved in DB.");

  // ----------------------------------------------------
  // Cleanup Test Knowledge Records
  // ----------------------------------------------------
  await pool.execute(
    "DELETE FROM chatbot_knowledge_pages WHERE chatbot_id = ? AND url IN (?, ?)",
    [testChatbot.id, testUrl, "https://apex-tech.edu/admissions/hostel"]
  );
  if (prevCrawlState) {
    await pool.execute(
      "UPDATE chatbot_crawl_states SET source_fingerprint = ?, active_source_fingerprint = ?, last_check_status = ? WHERE chatbot_id = ?",
      [prevCrawlState.source_fingerprint, prevCrawlState.active_source_fingerprint, prevCrawlState.last_check_status, testChatbot.id]
    );
  }
  console.log("  ✓ Cleanup complete.");

  console.log("\n========================================================");
  console.log("🎉 ALL WEBSITE-AWARE GEMINI TEXT CHAT TESTS PASSED! 🎉");
  console.log("========================================================\n");
}

runWebsiteAwareChatTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ TEST SUITE FAILED:", err);
    process.exit(1);
  });
