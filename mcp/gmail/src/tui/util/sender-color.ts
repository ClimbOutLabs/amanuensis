import type { Theme } from "../themes/index.js";

// Pick a deterministic colour for a sender address. The same address always
// maps to the same palette slot so a multi-message thread paints each
// participant a consistent hue — vim-mail-style. Keep the palette small (5
// entries) so the hash collisions are rare in practice but the colours stay
// readable across all 8 themes.
//
// Theme tokens chosen:
//   accent, warning, success, error are present in every theme;
//   `fg` is the fallback / "default" colour and reserved for unknown senders.
export function senderColor(theme: Theme, sender: string): string {
  const palette = [theme.accent, theme.warning, theme.success, theme.error, theme.fg];
  const idx = hash(normalize(sender)) % palette.length;
  return palette[idx] ?? theme.fg;
}

// Extract just the address part — "Foo <foo@bar.com>" → "foo@bar.com".
// Senders that already arrive as bare addresses pass through. Lowercased so
// case differences don't reshuffle the palette.
export function normalize(sender: string): string {
  const m = sender.match(/<([^>]+)>/);
  const addr = (m ? m[1] : sender).trim().toLowerCase();
  return addr;
}

// Display-friendly "name" — "Foo <foo@bar.com>" → "Foo"; bare-address
// senders fall back to the local-part of the address ("foo@bar.com" → "foo").
export function senderDisplayName(sender: string): string {
  const m = sender.match(/^([^<]+?)\s*<([^>]+)>\s*$/);
  if (m) {
    const name = m[1].replace(/^["']|["']$/g, "").trim();
    if (name) return name;
    return m[2].split("@")[0] ?? sender;
  }
  return sender.split("@")[0] ?? sender;
}

// FNV-1a — small, deterministic, no deps. Good enough for the palette index.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
