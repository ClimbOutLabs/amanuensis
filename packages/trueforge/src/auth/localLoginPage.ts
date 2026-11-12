/**
 * The local sign-in pages Aman serves itself: the first-run create form and the
 * sign-in form. Plain pages with no script, in the shape of the sign-in form the
 * installed path shows, so the two ways in feel the same.
 */

/** Headers for a page that takes a password: never framed, never cached, never sent elsewhere. */
export const LOCAL_LOGIN_PAGE_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'cache-control': 'no-store',
};

const PAGE_STYLE = `
  body { margin: 0; font-family: system-ui, sans-serif; background: #f6f4ef; color: #1c1a17; }
  main { max-width: 24rem; margin: 12vh auto 0; padding: 0 1rem; }
  .card { background: #ffffff; border: 1px solid #ddd6c9; border-radius: 0.75rem; padding: 1.5rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { font-size: 0.875rem; line-height: 1.45; }
  .error { color: #9c2b1b; font-weight: 600; }
  label { display: block; font-size: 0.875rem; font-weight: 600; margin: 1rem 0 0.25rem; }
  .hint { font-size: 0.75rem; color: #5c564c; margin: 0.25rem 0 0; }
  input { width: 100%; box-sizing: border-box; font-size: 1rem; padding: 0.5rem; border: 1px solid #b8b0a1; border-radius: 0.375rem; }
  button { width: 100%; margin-top: 1.25rem; font-size: 1rem; padding: 0.625rem; border: 0; border-radius: 0.375rem; background: #1c1a17; color: #ffffff; cursor: pointer; }
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function page(params: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(params.title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<div class="card">
${params.body}
</div>
</main>
</body>
</html>
`;
}

function errorLine(error: string | undefined): string {
  return error === undefined ? '' : `<p class="error" role="alert">${escapeHtml(error)}</p>\n`;
}

function returnToField(returnTo: string): string {
  return returnTo === '' ? '' : `<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">\n`;
}

/** First run, while no local user exists: email and a password typed twice. The form posts to the create path. */
export function localCreateAccountPage(params: { returnTo: string; email?: string; error?: string }): string {
  const body = `<h1>Create your sign-in</h1>
<p>This sign-in belongs to this Aman on this computer. There is only one, and it can change every setting.</p>
${errorLine(params.error)}<form method="post" action="create-account">
${returnToField(params.returnTo)}<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(params.email ?? '')}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="new-password" required>
<p class="hint">At least 8 characters.</p>
<label for="password_confirm">Type the password again</label>
<input id="password_confirm" name="password_confirm" type="password" autocomplete="new-password" required>
<button type="submit">Create sign-in</button>
</form>`;
  return page({ title: 'Create your sign-in', body });
}

/** The everyday form, with the one line that says how a forgotten password is reset. */
export function localSignInPage(params: { returnTo: string; email?: string; error?: string }): string {
  const body = `<h1>Sign in</h1>
${errorLine(params.error)}<form method="post" action="login">
${returnToField(params.returnTo)}<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(params.email ?? '')}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>
</form>
<p class="hint">Forgot your password? Stop Aman, run <code>npx amanuensis --reset-password</code>, then start Aman again.</p>`;
  return page({ title: 'Sign in', body });
}
