import { pool } from "../src/config/database.js";
import { sendPublicWidgetMessage, savePublicLead } from "../src/services/chatbotService.js";

async function runAcceptanceTests() {
  console.log("==================================================");
  console.log("RUNNING MULTI-CONCEPT RETRIEVAL ACCEPTANCE TESTS");
  console.log("==================================================");

  const chatbotPublicId = "32a70fb9-b004-11f1-a437-5c60ba70f3fe";
  const visitorId = "test_acceptance_" + Date.now();

  // Complete lead capture first
  await savePublicLead({
    publicId: chatbotPublicId,
    visitorId,
    fields: {
      "field-1789365061576": "Test User",
      "field-1789365077860": "test@example.com",
    },
  });

  const testCases = [
    {
      name: "TEST A: What are React components?",
      query: "What are React components?",
      validate: (res) => {
        const text = (res.reply || res.answer || "").toLowerCase();
        return text.includes("component") && (text.includes("ui") || text.includes("function") || text.includes("piece") || text.includes("reusable"));
      },
    },
    {
      name: "TEST B: What are props?",
      query: "What are props?",
      validate: (res) => {
        const text = (res.reply || res.answer || "").toLowerCase();
        return text.includes("prop") && (text.includes("pass") || text.includes("information") || text.includes("component") || text.includes("data"));
      },
    },
    {
      name: "TEST C: How do components use props and state together?",
      query: "How do components use props and state together?",
      validate: (res) => {
        const text = (res.reply || res.answer || "").toLowerCase();
        // Expect: lifting state up / parent / pass down via props
        const hasLifting = text.includes("lifting state up") || text.includes("lift");
        const hasPropsAndState = text.includes("prop") && text.includes("state");
        const hasParentOrShare = text.includes("parent") || text.includes("share") || text.includes("pass");
        return hasPropsAndState && (hasLifting || hasParentOrShare);
      },
    },
    {
      name: "TEST D: What is useState and useEffect?",
      query: "What is useState and useEffect?",
      validate: (res) => {
        const text = (res.reply || res.answer || "").toLowerCase();
        // Expect: BOTH useState AND useEffect explained
        const hasUseState = text.includes("usestate") && (text.includes("state") || text.includes("declare") || text.includes("hook"));
        const hasUseEffect = (text.includes("useeffect") || text.includes("effect")) && (text.includes("synchroniz") || text.includes("external") || text.includes("render") || text.includes("outside") || text.includes("side effect") || text.includes("connection"));
        return hasUseState && hasUseEffect;
      },
    },
    {
      name: "TEST E: What is the difference between props and state?",
      query: "What is the difference between props and state?",
      validate: (res) => {
        const text = (res.reply || res.answer || "").toLowerCase();
        const hasProps = text.includes("prop");
        const hasState = text.includes("state");
        return hasProps && hasState;
      },
    },
    {
      name: "TEST F: How do I share state between two components?",
      query: "How do I share state between two components?",
      validate: (res) => {
        const text = (res.reply || res.answer || "").toLowerCase();
        return (text.includes("lifting state up") || text.includes("parent") || text.includes("common")) && text.includes("prop");
      },
    },
  ];

  let passed = 0;

  for (const tc of testCases) {
    console.log(`\n>>> Executing: ${tc.name}`);
    try {
      const response = await sendPublicWidgetMessage({
        publicId: chatbotPublicId,
        visitorId,
        text: tc.query,
      });

      console.log(`--- [Response] ---`);
      console.log(`Answer:\n${response.answer || response.reply}`);
      console.log(`FollowUpPrompt: ${response.followUpPrompt}`);
      console.log(`Suggestions (${response.suggestions?.length || 0}):`, response.suggestions);

      const isValid = tc.validate(response);
      if (isValid) {
        console.log(`✅ ${tc.name}: PASSED`);
        passed++;
      } else {
        console.error(`❌ ${tc.name}: FAILED validation`);
      }
    } catch (err) {
      console.error(`❌ ${tc.name} encountered error:`, err.message);
    }
  }

  console.log(`\n==================================================`);
  console.log(`ACCEPTANCE RESULTS: ${passed}/${testCases.length} PASSED`);
  console.log(`==================================================`);

  if (passed === testCases.length) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runAcceptanceTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
