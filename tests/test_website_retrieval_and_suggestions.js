import { strict as assert } from 'node:assert';
import {
  tokenizeQuery,
  getMeaningfulTokens,
  extractRelevantWindow,
  searchKnowledgeExcerpts,
  generateWebsiteSuggestedQuestions,
} from '../src/services/chatbotKnowledgeService.js';
import { extractCleanContent, extractInternalLinks } from '../src/services/crawlerService.js';
import { sendPublicWidgetMessage, savePublicLead, getPublicWidgetConfig } from '../src/services/chatbotService.js';

async function runTests() {
  console.log('=== TEST SUITE: Website Retrieval Accuracy & Dynamic Suggestions ===');

  // Test 1: Stopword removal
  console.log('[1] Testing query tokenization and stopword removal...');
  const tokens = tokenizeQuery('What is Django, and what is it used for?');
  const meaningful = getMeaningfulTokens('What is Django, and what is it used for?');
  assert(meaningful.includes('django'), 'Should retain django');
  assert(!meaningful.includes('what'), 'Should remove what');
  assert(!meaningful.includes('is'), 'Should remove is');
  assert(!meaningful.includes('and'), 'Should remove and');
  console.log('  ✓ Tokenization and stopword filtering verified.');

  // Test 2: Link preservation in crawler
  console.log('[2] Testing anchor link preservation during extraction...');
  const sampleHtml = '<div><p>Check the <a href="https://docs.djangoproject.com/">Django documentation</a> for details.</p></div>';
  const { text } = extractCleanContent(sampleHtml, 'https://www.djangoproject.com');
  assert(text.includes('https://docs.djangoproject.com/'), 'Link URL should be preserved');
  assert(text.includes('Django documentation'), 'Anchor text should be preserved');
  console.log('  ✓ Link preservation verified.');

  // Test 3: Definitional excerpt density scoring
  console.log('[3] Testing smart excerpt window extraction...');
  const corpus = `
    Top Navigation Menu
    Overview (https://example.com/start)
    Download (https://example.com/download)
    ${'Toggle theme (current theme: light)\n\n'.repeat(5)}
    Meet FooBar
    FooBar is a high-level developer framework designed to simplify backend workflows. It takes care of routing and caching so you can focus on building your app.
    ${'More information about secondary tools and community members.\n\n'.repeat(10)}
    Footer
    &copy; 2026 FooBar Inc. All rights reserved.
  `;
  const excerpt = extractRelevantWindow(corpus, 'What is FooBar, and what is it used for?');
  assert(excerpt.includes('FooBar is a high-level developer framework'), 'Excerpt must contain definition');
  assert(!excerpt.includes('All rights reserved'), 'Excerpt should avoid footer boilerplate');
  console.log('  ✓ Smart excerpt density scoring verified.');

  // Test 4: Django chatbot suggested questions
  console.log('[4] Verifying Django chatbot dynamic suggestions...');
  const config = await getPublicWidgetConfig('2c07f5cc-3383-439f-ae51-18b78c58534e');
  const suggestions = config.config?.suggestedQuestions || [];
  assert(suggestions.length > 0, 'Suggestions must not be empty');
  const suggestionsText = suggestions.join(' ').toLowerCase();
  assert(!suggestionsText.includes('b.tech'), 'No B.Tech in Django chatbot');
  assert(!suggestionsText.includes('admission'), 'No admission in Django chatbot');
  assert(suggestionsText.includes('django'), 'Suggestions must be about Django');
  console.log('  ✓ Django chatbot suggestions verified:', suggestions);

  // Test 5: Grounded retrieval for Django questions
  console.log('[5] Testing grounded question answering on public widget...');
  const visitorId = 'audit-test-' + Date.now();
  await savePublicLead({
    publicId: '2c07f5cc-3383-439f-ae51-18b78c58534e',
    visitorId,
    fields: { name: 'Audit User', email: 'audit@example.com' },
  });

  const answerDoc = await sendPublicWidgetMessage({
    publicId: '2c07f5cc-3383-439f-ae51-18b78c58534e',
    visitorId,
    text: 'Where can I find the official Django documentation?',
  });
  assert(answerDoc.reply.includes('docs.djangoproject.com'), 'Answer must cite docs.djangoproject.com');
  assert(answerDoc.intent === 'website_grounded', 'Intent must be website_grounded');
  console.log('  ✓ Official documentation link successfully retrieved and cited.');

  console.log('=== ALL TESTS PASSED SUCCESSFULLY! ===');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
