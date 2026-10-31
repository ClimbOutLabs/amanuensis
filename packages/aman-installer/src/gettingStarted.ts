// The getting started page: one small page of plain words that the
// first install saves into the Amanuensis folder and opens in the
// person's browser at the end. It names only what is already true when
// it opens: Aman is installed, and the Settings pages where the rest
// is set. It promises nothing else.

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

// The page text, with the address Aman opens at filled in. The lines
// are in the order a person meets them: what just happened, then the
// Settings pages, then the closing line.
export function gettingStartedPage(address: string): string {
  const safe = escapeHtml(address);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>Getting started with Aman</title>',
    '<style>',
    'body { font-family: system-ui, sans-serif; max-width: 38rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }',
    'h1 { font-size: 1.5rem; }',
    '</style>',
    '</head>',
    '<body>',
    '<h1>Getting started</h1>',
    `<p>Aman is installed on this computer. Open it at <a href="${safe}">${safe}</a>.</p>`,
    "<p>Set the assistant's name, identity and voice in Settings, then Personalization.</p>",
    '<p>Add another model provider or key in Settings, then Models.</p>',
    '<p>Your morning brief lives in Settings, then Schedules.</p>',
    '<p>The connectors live in Settings, then Connectors.</p>',
    '<p>You can change any of this any time in Settings.</p>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
