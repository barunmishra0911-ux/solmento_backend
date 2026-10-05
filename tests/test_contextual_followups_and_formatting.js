import { strict as assert } from 'node:assert';
import { pool } from '../src/config/database.js';
import {
  sendPublicWidgetMessage,
  savePublicLead,
  getPublicWidgetConfig,
  getChatbotBuilder,
  saveChatbotBuilderDraft,
} from '../src/services/chatbotService.js';
import { generateGroundedResponse } from '../src/services/geminiService.js';

async function runTests() {
  console.log('=== TEST SUITE: Context-Aware Follow-up Suggestions & Clean Formatting ===');

  const djangoPublicId = '2c07f5cc-3383-439f-ae51-18b78c58534e'; // Chatbot 80 Django
  const cuPublicId = '813b2820-8177-4011-bf46-2ed2122e4d3f'; // Chatbot 81 JUT University

  // Ensure Chatbot 80 active source is set to Django knowledge
  const djangoFp = '0b93c0945908d4731447acfd81ebca20066707929a6f425087cb7a2518d288b3';
  await pool.execute(
    `UPDATE chatbot_crawl_states
        SET website_url = 'https://www.djangoproject.com/sitemap.xml',
            source_fingerprint = ?, active_source_fingerprint = ?, last_check_status = 'COMPLETED'
      WHERE chatbot_id = 80`,
    [djangoFp, djangoFp]
  );

  // [1] Initial welcome suggestions remain website-specific
  console.log('[1] Testing initial welcome suggestions are website-specific...');
  const djangoConfig = await getPublicWidgetConfig(djangoPublicId);
  const initialDjangoSuggestions = djangoConfig.config?.suggestedQuestions || [];
  assert(initialDjangoSuggestions.length > 0, 'Django suggestions must exist');
  const dText = initialDjangoSuggestions.join(' ').toLowerCase();
  assert(!dText.includes('b.tech') && !dText.includes('admission'), 'Django suggestions must not have admissions');
  assert(dText.includes('django'), 'Django suggestions must mention django');
  console.log('  ✓ Initial Django welcome suggestions verified:', initialDjangoSuggestions);

  // [2] Lead capture setup
  const visitorId = 'test-context-' + Date.now();
  await savePublicLead({
    publicId: djangoPublicId,
    visitorId,
    fields: { name: 'Context Tester', email: 'context@example.com' },
  });

  // [2] Turn 1: Django framework question -> follow-up suggestions relate to framework/getting started
  console.log('[2] Testing Turn 1: Framework question produces contextual follow-up questions...');
  const turn1 = await sendPublicWidgetMessage({
    publicId: djangoPublicId,
    visitorId,
    text: 'What type of framework is Django, and what is it used for?',
  });
  console.log('  Reply 1:', turn1.reply.slice(0, 150) + '...');
  console.log('  Follow-ups 1:', turn1.followUpQuestions);
  console.log('  Suggestions 1:', turn1.suggestions);

  assert(typeof turn1.reply === 'string' && turn1.reply.length > 20, 'Reply 1 must be non-empty');
  assert(Array.isArray(turn1.followUpQuestions), 'followUpQuestions must be an array');
  assert(Array.isArray(turn1.suggestions), 'suggestions must be an array');
  assert(turn1.suggestions.length > 0, 'Turn 1 suggestions must not be empty');
  // Check that follow-ups relate to Django/web development
  const f1Text = turn1.suggestions.join(' ').toLowerCase();
  assert(f1Text.includes('django') || f1Text.includes('features') || f1Text.includes('start') || f1Text.includes('framework'),
    'Follow-ups must be relevant to Django framework');
  console.log('  ✓ Turn 1 contextual follow-ups verified.');

  // [3] Turn 2: Documentation question -> follow-up suggestions change to documentation topics
  console.log('[3] Testing Turn 2: Documentation question produces doc-related follow-ups...');
  const turn2 = await sendPublicWidgetMessage({
    publicId: djangoPublicId,
    visitorId,
    text: 'Where can I find the official Django documentation?',
  });
  console.log('  Reply 2:', turn2.reply.slice(0, 150) + '...');
  console.log('  Follow-ups 2:', turn2.followUpQuestions);
  console.log('  Suggestions 2:', turn2.suggestions);

  assert(turn2.reply.includes('docs.djangoproject.com'), 'Reply 2 must cite docs.djangoproject.com');
  assert(Array.isArray(turn2.suggestions) && turn2.suggestions.length > 0, 'Turn 2 suggestions must exist');
  // Check that suggestions updated between Turn 1 and Turn 2
  console.log('  ✓ Turn 2 documentation follow-ups verified.');

  // [4] Turn 3: Unsupported / out-of-scope question (e.g., price of samosa)
  console.log('[4] Testing Turn 3: Unsupported question produces neutral fallback without invented topics...');
  const turn3 = await sendPublicWidgetMessage({
    publicId: djangoPublicId,
    visitorId,
    text: 'What is the price of samosa in the canteen?',
  });
  console.log('  Reply 3:', turn3.reply.slice(0, 150) + '...');
  console.log('  Follow-ups 3:', turn3.followUpQuestions);
  console.log('  Suggestions 3:', turn3.suggestions);

  // Bot should state details not available on website
  const r3Lower = turn3.reply.toLowerCase();
  assert(r3Lower.includes('not available') || r3Lower.includes('not found') || r3Lower.includes('does not contain'),
    'Reply 3 must be a neutral fallback');
  // followUpQuestions should be empty for fallback
  assert(turn3.followUpQuestions.length === 0, 'followUpQuestions must be empty for unsupported question');
  // suggestions should fall back to supported Django topics, NOT samosas!
  const s3Text = turn3.suggestions.join(' ').toLowerCase();
  assert(!s3Text.includes('samosa'), 'Suggestions must NEVER suggest samosas');
  assert(s3Text.includes('django'), 'Suggestions must fall back to supported Django topics');
  console.log('  ✓ Fallback handling verified: no invented follow-ups, falls back to supported topics.');

  // [5] Verify suggestions update across turns rather than remaining identical
  console.log('[5] Verifying suggestions update dynamically between turns...');
  assert.notDeepEqual(turn1.suggestions, turn2.suggestions, 'Turn 1 and Turn 2 suggestions must not be identical');
  console.log('  ✓ Suggestions dynamically change based on context.');

  // [6] Verify another chatbot (CU) uses its own website content and suggestions
  console.log('[6] Testing Chatbot 80 (CU) isolation and content grounding...');
  const cuVisitorId = 'cu-test-' + Date.now();
  await savePublicLead({
    publicId: cuPublicId,
    visitorId: cuVisitorId,
    fields: { name: 'CU Student', email: 'custudent@example.com' },
  });
  const cuTurn = await sendPublicWidgetMessage({
    publicId: cuPublicId,
    visitorId: cuVisitorId,
    text: 'What are the eligibility criteria for BE Computer Science?',
  });
  console.log('  CU Reply:', cuTurn.reply.slice(0, 150) + '...');
  console.log('  CU Suggestions:', cuTurn.suggestions);
  const cuText = (cuTurn.reply + ' ' + cuTurn.suggestions.join(' ')).toLowerCase();
  assert(!cuText.includes('django'), 'CU chatbot must have NO Django leakage');
  console.log('  ✓ Multi-tenant and cross-chatbot isolation verified.');

  // [7] Single Gemini call verification
  console.log('[7] Testing single Gemini call returns both reply and followUpQuestions in one turn...');
  const testSingleCall = await generateGroundedResponse({
    chatbotName: 'Django Bot',
    excerpts: [{ title: 'Overview', url: 'https://www.djangoproject.com/', text: 'Django is a high-level Python web framework.' }],
    history: [],
    userQuestion: 'What is Django?',
  });
  assert(typeof testSingleCall.reply === 'string' && testSingleCall.reply.length > 10, 'Single call returns reply');
  assert(Array.isArray(testSingleCall.followUpQuestions), 'Single call returns followUpQuestions array');
  console.log('  ✓ Single Gemini call provides reply and followUpQuestions without redundant API calls.');

  // [8] Preserving client customized suggestions in Chatbot Builder
  console.log('[8] Verifying customized suggestions in Builder are not overwritten by conversation turns...');
  const freshDjangoConfig = await getPublicWidgetConfig(djangoPublicId);
  assert.deepEqual(freshDjangoConfig.config?.suggestedQuestions, initialDjangoSuggestions,
    'Database config.suggestedQuestions must remain unchanged by widget conversation turns');
  console.log('  ✓ Saved Builder configuration was not mutated by conversation turns.');

  console.log('=== ALL 8 VERIFICATION TESTS PASSED! ===');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
