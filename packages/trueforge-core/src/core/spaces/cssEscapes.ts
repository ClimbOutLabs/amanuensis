/**
 * Decodes CSS escapes so `u\72l(` and `@\69mport` are seen as the browser reads them. Escapes
 * that would yield a backslash, NUL, a surrogate, or an out-of-range code point are dropped or
 * replaced so decoding can never produce a fresh escape. Shared by the server's link check and
 * the client's sanitiser, so both read a space's CSS the same way.
 */
export function decodeCssEscapes(css: string): string {
  const decoded = css.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|(\r\n|[\n\r\f])|([\s\S]))/g,
    (_match, hex: string | undefined, newline: string | undefined, char: string | undefined) => {
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        if (code === 0x5c) {
          return '';
        }
        if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
          return '�';
        }
        return String.fromCodePoint(code);
      }
      if (newline !== undefined) {
        return '';
      }
      return char === '\\' ? '' : (char ?? '');
    },
  );
  return decoded.replaceAll('\\', '');
}
