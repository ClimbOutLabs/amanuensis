import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_OCR_LANGUAGES,
  OCR_SCRIPT_LANGUAGES,
  ocrLanguageSelectionScript,
  requiredOcrLanguages,
  tesseractPackageFor,
} from '../../../src/documents/ocrLanguages';

const ALL_INSTALLED = requiredOcrLanguages(DEFAULT_OCR_LANGUAGES);

describe('script to OCR language selection', () => {
  it('reads each script with that script only: no all-languages run', () => {
    expect(OCR_SCRIPT_LANGUAGES['Latin']).toEqual(['eng', 'por', 'spa', 'fra', 'deu', 'ita', 'nld']);
    expect(OCR_SCRIPT_LANGUAGES['Devanagari']).toEqual(['hin', 'mar']);
    expect(OCR_SCRIPT_LANGUAGES['Arabic']).toEqual(['ara']);
    expect(OCR_SCRIPT_LANGUAGES['Cyrillic']).toEqual(['rus']);
    expect(OCR_SCRIPT_LANGUAGES['Han']).toEqual(['chi_sim', 'chi_tra']);
    expect(OCR_SCRIPT_LANGUAGES['Japanese']).toEqual(['jpn']);
    expect(OCR_SCRIPT_LANGUAGES['Korean']).toEqual(['kor']);
    expect(OCR_SCRIPT_LANGUAGES['Hangul']).toEqual(['kor']);
  });

  it('defaults to a Latin set the sandbox image carries', () => {
    expect(DEFAULT_OCR_LANGUAGES.split(' ')).toEqual(OCR_SCRIPT_LANGUAGES['Latin']);
  });

  it('needs every script language, script detection, and any extra configured language, once each', () => {
    const required = requiredOcrLanguages('eng deu swe bad;code');
    expect(required).toEqual(
      expect.arrayContaining([
        'eng',
        'por',
        'hin',
        'mar',
        'ara',
        'rus',
        'chi_sim',
        'chi_tra',
        'jpn',
        'kor',
        'osd',
        'swe',
      ]),
    );
    expect(required).not.toContain('bad;code');
    expect(new Set(required).size).toBe(required.length);
  });

  it('names the package that holds a language', () => {
    expect(tesseractPackageFor('chi_sim')).toBe('tesseract-ocr-chi-sim');
    expect(tesseractPackageFor('osd')).toBe('tesseract-ocr-osd');
  });
});

describe('the shell that picks languages for a page', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ocr-languages-'));
    // A stand-in tesseract: lists the installed packs, or reports the script it is told the page has.
    const stub = join(dir, 'tesseract');
    writeFileSync(
      stub,
      [
        '#!/bin/bash',
        'case "$*" in',
        '  *--list-langs*) printf \'List of available languages (3):\\n%s\\n\' "$INSTALLED" ;;',
        '  *--psm\\ 0*) if [ -n "$OSD_OUTPUT" ]; then printf \'%s\\n\' "$OSD_OUTPUT"; else echo "Too few characters. Skipping this page" >&2; exit 1; fi ;;',
        'esac',
      ].join('\n'),
    );
    chmodSync(stub, 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function selected({
    script,
    installed = ALL_INSTALLED,
    fallback = DEFAULT_OCR_LANGUAGES,
  }: {
    script: string | undefined;
    installed?: readonly string[];
    fallback?: string;
  }): string {
    const snippet = ocrLanguageSelectionScript({ imagePath: "'/pages/one.png'", fallback });
    return execFileSync('bash', ['-c', `set -eu; ${snippet}; printf '%s' "$ocr_languages"`], {
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        INSTALLED: installed.join('\n'),
        OSD_OUTPUT:
          script === undefined
            ? ''
            : `Page number: 0\nOrientation in degrees: 0\nScript: ${script}\nScript confidence: 2.10`,
      },
      encoding: 'utf8',
    });
  }

  it.each([
    ['Latin', 'eng+por+spa+fra+deu+ita+nld'],
    ['Devanagari', 'hin+mar'],
    ['Arabic', 'ara'],
    ['Cyrillic', 'rus'],
    ['Han', 'chi_sim+chi_tra'],
    ['Japanese', 'jpn'],
    ['Korean', 'kor'],
    ['Hangul', 'kor'],
  ])('reads a %s page with %s', (script, languages) => {
    expect(selected({ script })).toBe(languages);
  });

  it('falls back to the configured languages for a script it has no pack for', () => {
    expect(selected({ script: 'Greek', fallback: 'eng deu' })).toBe('eng+deu');
  });

  it('falls back to the configured languages when script detection fails', () => {
    expect(selected({ script: undefined, fallback: 'por spa' })).toBe('por+spa');
  });

  it('keeps only the packs that are installed, so a missing pack cannot break OCR', () => {
    expect(selected({ script: 'Devanagari', installed: ['eng', 'hin', 'osd'] })).toBe('hin');
    expect(selected({ script: 'Arabic', installed: ['eng', 'osd'] })).toBe('eng');
    expect(selected({ script: 'Latin', installed: ['eng', 'spa', 'osd'] })).toBe('eng+spa');
  });

  it('never runs a configured value as a command', () => {
    const marker = join(dir, 'ran');
    const result = selected({ script: undefined, fallback: `eng; touch ${marker}` });
    expect(result).toBe('eng');
    expect(() => execFileSync('test', ['-e', marker])).toThrow();
  });
});
