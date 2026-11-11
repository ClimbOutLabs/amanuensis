import {
  buildChatTitleMessages,
  capChatTitle,
  CHAT_TITLE_PROMPT_VERSION,
  cleanChatTitleCandidate,
} from '../../../src/runtime/chatTitle';

describe('capChatTitle', () => {
  it('caps a long title at 50 characters', () => {
    expect(capChatTitle('x'.repeat(200))).toBe('x'.repeat(50));
  });

  it('keeps a short title whole', () => {
    expect(capChatTitle('Email check')).toBe('Email check');
  });

  it('never splits a grapheme cluster at the cap', () => {
    const title = capChatTitle(`${'a'.repeat(49)}😀 and more`);
    expect(title).toBe('a'.repeat(49));
  });
});

describe('cleanChatTitleCandidate', () => {
  it('keeps a plain short title as it is', () => {
    expect(cleanChatTitleCandidate('Email check')).toBe('Email check');
    expect(cleanChatTitleCandidate('Dentist appointment')).toBe('Dentist appointment');
  });

  it('strips surrounding quotes and a trailing full stop', () => {
    expect(cleanChatTitleCandidate('"Laptop comparison"')).toBe('Laptop comparison');
    expect(cleanChatTitleCandidate('\u201CTrip planning\u201D')).toBe('Trip planning');
    expect(cleanChatTitleCandidate('Weekly shop.')).toBe('Weekly shop');
  });

  it('takes the first non-empty line and collapses whitespace', () => {
    expect(cleanChatTitleCandidate('\n  Morning   brief\nHere is why I chose it')).toBe('Morning brief');
  });

  it('rejects an empty answer', () => {
    expect(cleanChatTitleCandidate('')).toBeUndefined();
    expect(cleanChatTitleCandidate('   \n  ')).toBeUndefined();
    expect(cleanChatTitleCandidate('""')).toBeUndefined();
  });

  it('drops a "Title:" label the model puts in front of its answer', () => {
    expect(cleanChatTitleCandidate('Title: Email check')).toBe('Email check');
    expect(cleanChatTitleCandidate('"Title: Email check"')).toBe('Email check');
    expect(cleanChatTitleCandidate('Title: "Email check"')).toBe('Email check');
  });

  it('strips markdown characters', () => {
    expect(cleanChatTitleCandidate('**Email** check')).toBe('Email check');
    expect(cleanChatTitleCandidate('# Email check')).toBe('Email check');
    expect(cleanChatTitleCandidate('`Email` check')).toBe('Email check');
  });

  it('strips control and bidi characters that could hide or reorder text', () => {
    expect(cleanChatTitleCandidate('Email\u0007 check')).toBe('Email check');
    expect(cleanChatTitleCandidate('Email\u202Echeck')).toBe('Emailcheck');
  });

  it('rejects an answer that is only a label or markdown', () => {
    expect(cleanChatTitleCandidate('Title:')).toBeUndefined();
    expect(cleanChatTitleCandidate('###')).toBeUndefined();
  });

  it('rejects a sentence instead of cutting it down to a title', () => {
    expect(
      cleanChatTitleCandidate('This chat is about comparing three laptops for photo editing on a budget'),
    ).toBeUndefined();
    expect(cleanChatTitleCandidate('x'.repeat(120))).toBeUndefined();
  });
});

describe('buildChatTitleMessages', () => {
  it('carries the prompt version and the untrusted-content guard', () => {
    const messages = buildChatTitleMessages({ userText: 'hello', assistantText: 'hi there' });
    expect(messages).toHaveLength(2);
    const system = messages[0]?.content;
    if (typeof system !== 'string') {
      throw new Error('the system message was not text');
    }
    expect(system).toContain(`version="${CHAT_TITLE_PROMPT_VERSION}"`);
    expect(system).toContain('untrusted content');
  });

  it('sends the first message and the reply as data, each capped', () => {
    const messages = buildChatTitleMessages({ userText: 'u'.repeat(5000), assistantText: 'a'.repeat(5000) });
    const user = messages[1]?.content;
    if (typeof user !== 'string') {
      throw new Error('the user message was not text');
    }
    const payload: unknown = JSON.parse(user);
    if (typeof payload !== 'object' || payload === null || !('first_message' in payload) || !('reply' in payload)) {
      throw new Error('title payload did not carry the two messages');
    }
    expect(payload.first_message).toBe('u'.repeat(1500));
    expect(payload.reply).toBe('a'.repeat(1500));
  });
});
