// Made-up messages, one per charset. `data` is what Gmail returns for a part: the body bytes in the declared
// charset, base64url encoded, with the transfer encoding already removed.
export interface CharsetSample {
  name: string;
  charset: string;
  text: string;
  data: string;
}

export const CHARSET_SAMPLES: CharsetSample[] = [
  {
    name: 'portuguese',
    charset: 'iso-8859-1',
    text: 'Olá, já recebi o contrato. Até quinta-feira, ação confirmada.',
    data: 'T2zhLCBq4SByZWNlYmkgbyBjb250cmF0by4gQXTpIHF1aW50YS1mZWlyYSwgYefjbyBjb25maXJtYWRhLg',
  },
  {
    name: 'french',
    charset: 'windows-1252',
    text: 'Prix : 5 € — “bonjour” à tous',
    data: 'UHJpeCA6IDUggCCXIJNib25qb3VylCDgIHRvdXM',
  },
  {
    name: 'japaneseSjis',
    charset: 'shift_jis',
    text: 'お世話になっております。契約書を確認しました。',
    data: 'gqiQophigsmCyILBgsSCqILogtyCt4FCjF-W8Y-RgvCKbZRGgrWC3IK1gr2BQg',
  },
  {
    name: 'japaneseJis',
    charset: 'iso-2022-jp',
    text: '来週の木曜日にお会いしましょう',
    data: 'GyRCTWg9NSROTFpNS0Z8JEskKjJxJCQkNyReJDckZyQmGyhC',
  },
  {
    name: 'japaneseEuc',
    charset: 'euc-jp',
    text: '了解しました。よろしくお願いします。',
    data: 'zruy8qS3pN6kt6S_oaOk6KTtpLekr6SqtOqkpKS3pN6kuaGj',
  },
  {
    name: 'chineseGbk',
    charset: 'gbk',
    text: '您好，合同已经收到，谢谢。',
    data: 'xPq6w6Osus_NrNLRvq3K1bW9o6zQu9C7oaM',
  },
  {
    name: 'chineseBig5',
    charset: 'big5',
    text: '您好，合約已經收到，謝謝。',
    data: 'sXqmbqFBplis-aR3uGemrKjsoUHBwsHCoUM',
  },
  {
    name: 'russian',
    charset: 'koi8-r',
    text: 'Здравствуйте, договор получен. Спасибо.',
    data: '-sTSwdfT1NfVytTFLCDEz8fP18_SINDPzNXexc4uIPPQwdPJws8u',
  },
  {
    name: 'arabic',
    charset: 'utf-8',
    text: 'مرحبا، استلمت العقد. شكرا لك. الاجتماع الخميس 10:30.',
    data: '2YXYsdit2KjYp9iMINin2LPYqtmE2YXYqiDYp9mE2LnZgtivLiDYtNmD2LHYpyDZhNmDLiDYp9mE2KfYrNiq2YXYp9i5INin2YTYrtmF2YrYsyAxMDozMC4',
  },
  {
    name: 'hebrew',
    charset: 'utf-8',
    text: 'שלום, קיבלתי את החוזה. תודה רבה. נתראה ביום חמישי.',
    data: '16nXnNeV150sINen15nXkdec16rXmSDXkNeqINeU15fXldeW15QuINeq15XXk9eUINeo15HXlC4g16DXqteo15DXlCDXkdeZ15XXnSDXl9ee15nXqdeZLg',
  },
  {
    name: 'mixedRtl',
    charset: 'utf-8',
    text: 'Meeting with שלום עולם at 10:30 about "مرحبا" (42)',
    data: 'TWVldGluZyB3aXRoINep15zXldedINei15XXnNedIGF0IDEwOjMwIGFib3V0ICLZhdix2K3YqNinIiAoNDIp',
  },
];

export interface EncodedWordSample {
  name: string;
  header: string;
  decoded: string;
}

export const ENCODED_WORD_SAMPLES: EncodedWordSample[] = [
  {
    name: 'utf8 base64',
    header: '=?UTF-8?B?Q29udHJhdG8g4oCUIHJldmlzw6NvIGZpbmFs?=',
    decoded: 'Contrato — revisão final',
  },
  { name: 'latin1 quoted-printable', header: '=?iso-8859-1?Q?Ol=E1=2C_at=E9_j=E1?=', decoded: 'Olá, até já' },
  { name: 'iso-2022-jp base64', header: '=?iso-2022-jp?B?GyRCMnE1RCROTT1EahsoQg==?=', decoded: '会議の予定' },
  { name: 'shift_jis base64', header: '=?shift_jis?B?kL+LgY+RgsyRl5V0?=', decoded: '請求書の送付' },
  { name: 'gbk base64', header: '=?gbk?B?us/NrNLRytW1vQ==?=', decoded: '合同已收到' },
  { name: 'big5 base64', header: '=?big5?B?plis+aR3pqyo7A==?=', decoded: '合約已收到' },
  { name: 'koi8-r base64', header: '=?koi8-r?B?5M/Hz9fP0iDQz8zV3sXO?=', decoded: 'Договор получен' },
  {
    name: 'split across two words',
    header:
      '=?utf-8?B?5p2l6YCx44Gu5omT44Gh5ZCI44KP44Gb44Gu5Lu244Gr44Gk44GN?= \r\n =?utf-8?B?44G+44GX44Gm44CB6LOH5paZ44KS5YWx5pyJ44GE44Gf44GX44G+44GZ?=',
    decoded: '来週の打ち合わせの件につきまして、資料を共有いたします',
  },
  {
    name: 'mixed with ascii',
    header: 'Re: =?utf-8?B?16nXnNeV150g16LXldec150=?= (final)',
    decoded: 'Re: שלום עולם (final)',
  },
  {
    name: 'display name',
    header: '=?utf-8?B?Sm9zw6kgTcO8bGxlcg==?= <jose@example.com>',
    decoded: 'José Müller <jose@example.com>',
  },
];
