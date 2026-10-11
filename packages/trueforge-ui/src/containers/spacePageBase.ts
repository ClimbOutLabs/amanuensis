import { resolvePresetTokens } from '../theme/presets/index.js';
import type { SemanticTokens } from '../theme/types.js';

/**
 * Space-page variable to app theme token. `SpaceHtmlFrame` copies the live app values onto the
 * frame's `:root`; the same table seeds the fallbacks below from the default preset.
 */
export const SPACE_THEME_VARS: ReadonlyArray<{ spaceVar: string; token: keyof SemanticTokens }> = [
  { spaceVar: '--space-bg', token: 'primaryBg' },
  { spaceVar: '--space-text', token: 'textPrimary' },
  { spaceVar: '--space-muted', token: 'textSecondary' },
  { spaceVar: '--space-card-bg', token: 'cardBg' },
  { spaceVar: '--space-border', token: 'border' },
  { spaceVar: '--space-thead-bg', token: 'secondaryBg' },
  { spaceVar: '--space-accent', token: 'primaryButtonBg' },
  { spaceVar: '--space-accent-text', token: 'primaryButtonText' },
  { spaceVar: '--space-success-bg', token: 'successBg' },
  { spaceVar: '--space-success-text', token: 'successText' },
  { spaceVar: '--space-warning-bg', token: 'warningBg' },
  { spaceVar: '--space-warning-text', token: 'warningText' },
  { spaceVar: '--space-radius', token: 'radius' },
];

/** `:root` declarations for the frame, reading each token from `readToken` (live CSS var or preset). */
export function spaceThemeDeclarations(readToken: (token: keyof SemanticTokens) => string): string {
  return SPACE_THEME_VARS.map(({ spaceVar, token }) => `${spaceVar}:${readToken(token)};`).join('');
}

function presetDeclarations(mode: 'light' | 'dark'): string {
  const tokens = resolvePresetTokens(undefined, mode);
  const shadowAlpha = mode === 'dark' ? 40 : 8;
  return `${spaceThemeDeclarations(token => tokens[token])}--space-shadow:0 1px 2px color-mix(in srgb,${tokens.shadowColor} ${shadowAlpha}%,transparent);`;
}

/**
 * The design system every `format: 'html'` space page inherits. `SpaceHtmlFrame` (in
 * `SpacesView.tsx`) injects this as a `<style>` block ahead of the page's own `<style>`, so the
 * model only has to write semantic HTML (`.page-header`, `section`/`.card`, `table`, `.badge`,
 * `.grid-2`/`.grid-3`, `<details>`) and a small page-specific `<style>` for anything unusual; the
 * cascade lets that later `<style>` override anything here.
 *
 * Colors are CSS custom properties (`--space-*`) so the page follows the app's own light/dark
 * theme: `SpaceHtmlFrame` reads the app's theme tokens via `getComputedStyle` and writes measured
 * values onto `:root` in a `<style>` block placed *after* this one, so those real values win the
 * cascade over the fallbacks declared here. The fallbacks come from the default preset (light and
 * dark) so a space still reads as a designed page even where the host var block cannot run (no
 * `window`, e.g. a unit test render, or the frame opened standalone); `prefers-color-scheme`
 * picks the right set on its own.
 */
export const SPACE_PAGE_BASE_STYLE = `
:root{${presetDeclarations('light')}}
@media (prefers-color-scheme:dark){
  :root{${presetDeclarations('dark')}}
}
*,*::before,*::after{box-sizing:border-box;}
body{
  margin:0;
  padding:24px;
  background:var(--space-bg);
  color:var(--space-text);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-size:16px;
  line-height:1.55;
  -webkit-font-smoothing:antialiased;
}
h1,h2,h3,h4{
  color:var(--space-text);
  font-weight:600;
  line-height:1.25;
  margin:32px 0 12px;
}
h1:first-child,h2:first-child,h3:first-child,h4:first-child,.page-header:first-child{margin-top:0;}
h1{font-size:28px;letter-spacing:-0.01em;}
h2{font-size:22px;}
h3{font-size:18px;}
h4{font-size:14px;text-transform:uppercase;letter-spacing:0.04em;color:var(--space-muted);}
p,ul,ol{max-width:70ch;margin:0 0 12px;}
ul,ol{padding-left:20px;}
li{margin:4px 0;}
a{color:var(--space-accent);text-decoration:underline;text-underline-offset:2px;}
a:hover{opacity:0.85;}
.page-header{
  display:flex;
  flex-direction:column;
  gap:4px;
  margin:0 0 24px;
  padding-bottom:16px;
  border-bottom:1px solid var(--space-border);
}
.page-header h1{margin:0;}
.page-header .subtitle,.page-header p{margin:0;color:var(--space-muted);font-size:14px;max-width:70ch;}
.card,section{
  background:var(--space-card-bg);
  border:1px solid var(--space-border);
  border-radius:var(--space-radius);
  padding:16px;
  margin:0 0 16px;
  box-shadow:var(--space-shadow);
}
.card>:last-child,section>:last-child{margin-bottom:0;}
.card h2,.card h3,.card h4,section h2,section h3,section h4{margin-top:0;}
.grid-2,.grid-3{display:grid;gap:16px;margin:0 0 16px;}
.grid-2{grid-template-columns:repeat(2,minmax(0,1fr));}
.grid-3{grid-template-columns:repeat(3,minmax(0,1fr));}
.grid-2>.card,.grid-2>section,.grid-3>.card,.grid-3>section{margin-bottom:0;}
@media (max-width:640px){.grid-2,.grid-3{grid-template-columns:1fr;}}
table{
  width:100%;
  border-collapse:collapse;
  margin:0 0 16px;
  font-size:14px;
}
thead th{
  text-align:left;
  font-weight:600;
  color:var(--space-text);
  background:var(--space-thead-bg);
  border-bottom:2px solid var(--space-border);
  padding:8px 12px;
}
tbody td{
  padding:8px 12px;
  border-bottom:1px solid var(--space-border);
}
tbody tr:nth-child(even){background:var(--space-thead-bg);}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;}
img{max-width:100%;border-radius:var(--space-radius);display:block;}
details{
  border:1px solid var(--space-border);
  border-radius:var(--space-radius);
  padding:8px 12px;
  margin:0 0 12px;
  background:var(--space-card-bg);
}
details summary{cursor:pointer;font-weight:600;}
details[open] summary{margin-bottom:8px;}
.badge{
  display:inline-flex;
  align-items:center;
  gap:4px;
  padding:2px 8px;
  border-radius:999px;
  font-size:12px;
  font-weight:600;
  background:var(--space-border);
  color:var(--space-text);
}
.badge-success{background:var(--space-success-bg);color:var(--space-success-text);}
.badge-warning{background:var(--space-warning-bg);color:var(--space-warning-text);}
`.trim();
