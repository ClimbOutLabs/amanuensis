import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cjkCollectionPdf, unicodeTextPdf } from './syntheticFiles';

/** Native PDF text through poppler's own `pdftotext`, when this machine has it; the sandbox image installs it and poppler-data. */
const HAS_PDFTOTEXT = spawnSync('pdftotext', ['-v']).error === undefined;
const HAS_POPPLER_DATA = ['/usr/share/poppler/cMap', '/usr/local/share/poppler/cMap'].some(path => existsSync(path));

function pdftotext(pdf: Buffer): string {
  const result = spawnSync('pdftotext', ['-layout', '-', '-'], { input: pdf, encoding: 'utf8' });
  // Bidi embedding marks poppler wraps around right-to-left runs are not text, and it pads wide characters.
  return result.stdout.replace(/[‪-‮⁦-⁩\f]/g, '').trim();
}

/** An invented line per script; right-to-left text is placed in visual order, the way PDF producers write it. */
const PORTUGUESE = 'Fatura número 4200: pagamento até amanhã, São João';
const ARABIC = 'فاتورة الدفع غدا';
const HINDI = 'कुल राशि चार हजार दो सौ रुपये';

const describeIfPdftotext = HAS_PDFTOTEXT ? describe : describe.skip;

describeIfPdftotext('native text of PDFs in several scripts', () => {
  it('keeps Portuguese accents, Arabic in reading order, and Hindi conjuncts', () => {
    const text = pdftotext(unicodeTextPdf([PORTUGUESE, [...ARABIC].reverse().join(''), HINDI]));
    expect(text).toContain(PORTUGUESE);
    expect(text).toContain(ARABIC);
    expect(text).toContain(HINDI);
  });

  const itWithPopplerData = HAS_POPPLER_DATA ? it : it.skip;
  itWithPopplerData('reads Japanese, Chinese and Korean fonts that are not embedded, which needs poppler-data', () => {
    expect(
      pdftotext(
        cjkCollectionPdf({ ordering: 'Japan1', encoding: 'UniJIS-UCS2-H', lines: ['請求書の合計は四千二百円です'] }),
      ),
    ).toBe('請求書の合計は四千二百円です');
    expect(
      pdftotext(cjkCollectionPdf({ ordering: 'GB1', encoding: 'UniGB-UCS2-H', lines: ['发票总额为四千二百元'] })),
    ).toBe('发票总额为四千二百元');
    expect(
      pdftotext(
        cjkCollectionPdf({ ordering: 'Korea1', encoding: 'UniKS-UCS2-H', lines: ['청구서 합계는 사천이백 원입니다'] }),
      ),
    ).toBe('청구서 합계는 사천이백 원입니다');
  });
});
