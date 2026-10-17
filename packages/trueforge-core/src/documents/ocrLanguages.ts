import { shellEscape } from '../core/sandbox/provider/Provider';

/** Languages Tesseract reads when the page's script is unknown; Latin ones, which the slot sandbox image carries. */
export const DEFAULT_OCR_LANGUAGES = 'eng por spa fra deu ita nld';

/** Tesseract's orientation-and-script data, which names the script of a page. */
const OSD_DATA = 'osd';

const LATIN = ['eng', 'por', 'spa', 'fra', 'deu', 'ita', 'nld'] as const;
const HAN = ['chi_sim', 'chi_tra'] as const;
const JAPANESE = ['jpn'] as const;
const HANGUL = ['kor'] as const;

/**
 * Languages to read a page with, by the script Tesseract's orientation-and-script detection reports for it.
 * One script's languages at a time: running every language together is slow and less accurate.
 */
export const OCR_SCRIPT_LANGUAGES: Readonly<Record<string, readonly string[]>> = {
  Latin: LATIN,
  Fraktur: LATIN,
  Vietnamese: LATIN,
  Cyrillic: ['rus'],
  Arabic: ['ara'],
  Devanagari: ['hin', 'mar'],
  Han: HAN,
  HanS: HAN,
  HanT: HAN,
  Han_vert: HAN,
  HanS_vert: HAN,
  HanT_vert: HAN,
  Japanese: JAPANESE,
  Japanese_vert: JAPANESE,
  Hiragana: JAPANESE,
  Katakana: JAPANESE,
  // Tesseract names Korean pages "Korean"; "Hangul" is the script name its data files use.
  Korean: HANGUL,
  Hangul: HANGUL,
  Hangul_vert: HANGUL,
};

const LANGUAGE_CODE = /^[A-Za-z0-9_]+$/;

function splitLanguages(languages: string): string[] {
  return languages.split(/\s+/).filter(code => LANGUAGE_CODE.test(code));
}

/** Every language pack the sandbox needs for these settings: the script languages, the configured ones, and script detection. */
export function requiredOcrLanguages(configured: string): string[] {
  const all = [...Object.values(OCR_SCRIPT_LANGUAGES).flat(), ...splitLanguages(configured), OSD_DATA];
  return [...new Set(all)];
}

/** The Debian/Ubuntu package that holds one Tesseract language. */
export function tesseractPackageFor(language: string): string {
  return `tesseract-ocr-${language.replace(/_/g, '-')}`;
}

/**
 * Shell that sets `$ocr_languages` (joined with +) for the image in `imagePath`: it detects the script, takes
 * that script's languages, keeps the ones that are installed, and falls back to the configured languages when
 * the script is unknown, detection fails, or no installed pack matches.
 */
export function ocrLanguageSelectionScript({
  imagePath,
  fallback,
}: {
  /** Already shell-quoted. */
  imagePath: string;
  fallback: string;
}): string {
  const scriptsByLanguages = new Map<string, string[]>();
  for (const [script, languages] of Object.entries(OCR_SCRIPT_LANGUAGES)) {
    const key = languages.join(' ');
    scriptsByLanguages.set(key, [...(scriptsByLanguages.get(key) ?? []), script]);
  }
  const cases = [...scriptsByLanguages].map(
    ([languages, scripts]) => `${scripts.join('|')}) wanted=${shellEscape(languages)};;`,
  );
  const configured = splitLanguages(fallback).join(' ') || 'eng';
  return [
    `detected_script=$(tesseract ${imagePath} stdout --psm 0 2>/dev/null | sed -n 's/^Script: //p' | head -n 1)`,
    `installed=$(tesseract --list-langs 2>/dev/null || true)`,
    `case "$detected_script" in ${cases.join(' ')} *) wanted=${shellEscape(configured)};; esac`,
    `ocr_languages=''`,
    `for code in $wanted; do if printf '%s\\n' "$installed" | grep -qx -- "$code"; then ocr_languages="\${ocr_languages:+$ocr_languages+}$code"; fi; done`,
    `if [ -z "$ocr_languages" ]; then ocr_languages=eng; fi`,
  ].join('; ');
}
