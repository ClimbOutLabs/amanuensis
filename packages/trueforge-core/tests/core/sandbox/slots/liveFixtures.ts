import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Fonts on the machine running the live tests; install `fonts-dejavu-core fonts-unifont` for the full set. */
const DEJAVU = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
const UNIFONT = ['/usr/share/fonts/opentype/unifont/unifont_jp.otf', '/usr/share/fonts/truetype/unifont/unifont.ttf'];

export type ScriptFamily = 'latin' | 'arabic' | 'cyrillic' | 'devanagari' | 'chinese' | 'japanese' | 'korean';

interface FamilyFixture {
  fonts: readonly string[];
  fontSize: number;
  rtl: boolean;
  /** Invented lines, enough of them that script detection has text to work with. */
  lines: readonly string[];
  /** Words the reading must contain; OCR is not exact, so these are a few well-formed ones. */
  expected: readonly string[];
  /** Letters of the family's own script; a reading with many of them used the right language data. */
  script: RegExp;
}

export const FAMILY_FIXTURES: Readonly<Record<ScriptFamily, FamilyFixture>> = {
  latin: {
    fonts: DEJAVU,
    fontSize: 48,
    rtl: false,
    lines: [
      'Fatura número 4200: pagamento até amanhã.',
      'São João recebeu a encomenda ontem à tarde.',
      'O montante total inclui impostos e taxas de envio.',
      'Por favor, confirme a receção do documento.',
      'Obrigado pela sua preferência e confiança.',
    ],
    expected: ['Fatura', 'pagamento', 'encomenda'],
    script: /\p{Script=Latin}/gu,
  },
  arabic: {
    fonts: DEJAVU,
    fontSize: 48,
    rtl: true,
    lines: [
      'فاتورة رقم ٤٢٠٠ الدفع غدا',
      'المبلغ الإجمالي يشمل الضرائب ورسوم الشحن',
      'يرجى تأكيد استلام هذه الوثيقة اليوم',
      'شكرا لكم على ثقتكم الدائمة بنا',
      'نتمنى لكم يوما سعيدا',
    ],
    expected: ['فاتورة', 'المبلغ', 'الشحن'],
    script: /\p{Script=Arabic}/gu,
  },
  cyrillic: {
    fonts: DEJAVU,
    fontSize: 48,
    rtl: false,
    lines: [
      'Счёт на сумму четыре тысячи двести',
      'Оплата должна быть произведена завтра',
      'Пожалуйста подтвердите получение документа',
      'Спасибо за ваше доверие',
      'Хорошего дня',
    ],
    expected: ['Счёт', 'Оплата', 'документа'],
    script: /\p{Script=Cyrillic}/gu,
  },
  devanagari: {
    fonts: UNIFONT,
    fontSize: 56,
    rtl: false,
    lines: [
      'कुल राशि चार हजार दो सौ रुपये है',
      'कृपया इस दस्तावेज़ की प्राप्ति की पुष्टि करें',
      'भुगतान कल तक किया जाना चाहिए',
      'आपके विश्वास के लिए धन्यवाद',
      'आपका दिन शुभ हो',
      'यह एक परीक्षण दस्तावेज़ है जिसमें बहुत सारा पाठ है',
      'हम आशा करते हैं कि आप सभी स्वस्थ और प्रसन्न होंगे',
      'अगली बैठक सोमवार को सुबह दस बजे होगी',
      'कृपया सभी आवश्यक कागजात साथ लेकर आएं',
      'सभी सदस्यों को सूचित कर दिया गया है',
    ],
    // The bitmap font used here reads back imperfectly, so only the script is asserted.
    expected: [],
    script: /\p{Script=Devanagari}/gu,
  },
  chinese: {
    fonts: UNIFONT,
    fontSize: 48,
    rtl: false,
    lines: ['发票总额为四千二百元', '请在明天之前付款', '请确认收到此文件', '感谢您的信任与支持', '祝您愉快'],
    expected: ['发票', '付款', '文件'],
    script: /\p{Script=Han}/gu,
  },
  japanese: {
    fonts: UNIFONT,
    fontSize: 48,
    rtl: false,
    lines: [
      '請求書の合計は四千二百円です',
      'お支払いは明日までにお願いします',
      'この書類の受領を確認してください',
      'ご利用ありがとうございます',
      'よろしくお願いいたします',
    ],
    expected: ['請求書', 'お支払い', '書類'],
    script: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu,
  },
  korean: {
    fonts: UNIFONT,
    fontSize: 56,
    rtl: false,
    lines: [
      '청구서 합계는 사천이백 원입니다',
      '내일까지 결제해 주시기 바랍니다',
      '이 문서를 받으셨는지 확인해 주세요',
      '이용해 주셔서 감사합니다',
      '좋은 하루 되세요',
      '이것은 많은 글자가 들어 있는 시험 문서입니다',
      '다음 회의는 월요일 오전 열 시에 열립니다',
      '필요한 서류를 모두 가져오시기 바랍니다',
      '모든 회원에게 알려 드렸습니다',
      '귀하의 건강과 행복을 기원합니다',
    ],
    expected: ['결제', '문서'],
    script: /\p{Script=Hangul}/gu,
  },
};

const RENDER_SCRIPT = [
  'import json, sys',
  'from PIL import Image, ImageDraw, ImageFont, features',
  'spec = json.load(sys.stdin)',
  'font = ImageFont.truetype(spec["font"], spec["size"])',
  'step = spec["size"] * 2',
  'img = Image.new("RGB", (2400, step * len(spec["lines"]) + 60), "white")',
  'draw = ImageDraw.Draw(img)',
  'kwargs = {"direction": "rtl"} if spec["rtl"] and features.check("raqm") else {}',
  'for index, line in enumerate(spec["lines"]):',
  '    draw.text((40, 30 + index * step), line, fill="black", font=font, **kwargs)',
  'img.save(sys.stdout.buffer, format="PNG")',
].join('\n');

/** Why a family cannot be drawn on this machine, or undefined when it can. */
export function missingForFamily(family: ScriptFamily): string | undefined {
  if (!FAMILY_FIXTURES[family].fonts.some(path => existsSync(path))) {
    return `no font for ${family} (install fonts-dejavu-core and fonts-unifont)`;
  }
  const probe = spawnSync('python3', ['-I', '-c', 'import PIL'], { encoding: 'utf8' });
  return probe.status === 0 ? undefined : 'python3 with Pillow is missing (install python3-pil and libraqm0)';
}

/** A PNG of the family's invented text, drawn with Pillow on this machine. */
export function renderFamilyPng(family: ScriptFamily): Buffer {
  const fixture = FAMILY_FIXTURES[family];
  const font = fixture.fonts.find(path => existsSync(path));
  if (font === undefined) {
    throw new Error(`no font for ${family}`);
  }
  const result = spawnSync('python3', ['-I', '-c', RENDER_SCRIPT], {
    input: JSON.stringify({ font, size: fixture.fontSize, rtl: fixture.rtl, lines: fixture.lines }),
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`could not draw ${family} text: ${result.stderr.toString()}`);
  }
  return result.stdout;
}
