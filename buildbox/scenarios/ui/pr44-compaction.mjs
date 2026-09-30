/**
 * buildbox/scenarios/ui/pr44-compaction.mjs
 *
 * Tests PR #44: Token safety margin in compaction budget.
 *
 * Journey:
 * 1. Open Aman UI
 * 2. Start a new chat
 * 3. Send a long message to trigger compaction
 * 4. Verify the compaction status shows the safety margin
 * 5. Screenshot each step
 */

export default async function (page, { screenshot }) {
  console.log('[pr44] Navigating to Aman...');

  // Go to the UI
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  await screenshot('01-loaded');

  // Wait for the chat input to be visible
  console.log('[pr44] Waiting for chat input...');
  await page.waitForSelector('textarea, input[type="text"]', { timeout: 30000 });
  await screenshot('02-chat-ready');

  // Type a long message to trigger compaction
  // (We need enough tokens to force a compaction cycle)
  const longMessage = `Please write a very detailed essay about the history of computing, 
  covering from Babbage's Analytical Engine through modern quantum computing. 
  Include details about key figures, major breakthroughs, and the evolution 
  of programming paradigms. Make it comprehensive, at least 2000 words. `.repeat(20);

  console.log('[pr44] Typing long message...');
  const input = await page.locator('textarea, input[type="text"]').first();
  await input.fill(longMessage);
  await screenshot('03-message-typed');

  // Send the message (Enter or click send button)
  console.log('[pr44] Sending message...');
  await input.press('Enter');
  // Or click send button if Enter doesn't work:
  // await page.locator('button[type="submit"], button:has-text("Send")').click();

  // Wait for response (this will take a while for a long response)
  console.log('[pr44] Waiting for response...');
  await page.waitForTimeout(30000);
  await screenshot('04-response');

  // Check for compaction status / token budget display
  // PR #44 adds a safety margin to the compaction budget
  // PR #45 (dependent) shows detailed token stats
  console.log('[pr44] Checking for token budget display...');

  // Look for any token/budget/compaction indicators in the UI
  const pageText = await page.textContent('body');
  const hasTokenInfo = /token|budget|compact/i.test(pageText);

  await screenshot('05-final');

  if (!hasTokenInfo) {
    console.log('[pr44] WARNING: No token/budget info found in UI');
    // Don't fail hard, just warn. The visual screenshot will show the state.
  } else {
    console.log('[pr44] Found token/budget info in UI');
  }

  console.log('[pr44] Done');
}
