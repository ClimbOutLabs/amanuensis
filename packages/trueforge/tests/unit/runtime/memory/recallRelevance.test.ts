import { isFromCurrentChat, keywordMatches, queryWords } from '../../../../src/runtime/memory/recallRelevance';

const notes = [
  { text: 'Turn summary: Lexie the Bernese Mountain Dog sees the vet every spring.' },
  { text: 'Turn summary: Booked flights SFO to MAD for the week of Sep 22.' },
  { text: 'Turn summary: The dentist is Dr Rivera, appointments on Tuesdays.' },
  { text: 'Turn summary: Prefers window seats and vegetarian meals.' },
  { text: 'Turn summary: Wants to sent the quarterly report to the board this week.' },
];

function recalled(query: string): string[] {
  return keywordMatches({ query, notes })
    .map(match => match.note.text)
    .sort();
}

describe('isFromCurrentChat', () => {
  const base = { text: 'Turn summary: x', chatTitle: undefined };

  it('matches only the recorded chat id', () => {
    expect(isFromCurrentChat({ ...base, metadata: { session_id: 's1' }, sessionId: 's1' })).toBe(true);
    expect(isFromCurrentChat({ ...base, metadata: { session_id: 's2' }, sessionId: 's1' })).toBe(false);
  });

  it('treats a note with no recorded chat, or no current chat, as another chat', () => {
    expect(isFromCurrentChat({ ...base, metadata: undefined, sessionId: 's1' })).toBe(false);
    expect(isFromCurrentChat({ ...base, metadata: { origin: 'user_stated' }, sessionId: 's1' })).toBe(false);
    expect(isFromCurrentChat({ ...base, metadata: { session_id: 's1' }, sessionId: undefined })).toBe(false);
    expect(isFromCurrentChat({ ...base, metadata: { session_id: '' }, sessionId: '' })).toBe(false);
  });

  describe('for a note from before notes recorded their chat', () => {
    const old = { text: 'Turn summary: x\n\n> Chat title: Trip planning', metadata: undefined, sessionId: 's1' };

    it('matches the chat title line', () => {
      expect(isFromCurrentChat({ ...old, chatTitle: 'Chat title: Trip planning' })).toBe(true);
    });

    it('does not match another title, a title that is only part of the line, or no title', () => {
      expect(isFromCurrentChat({ ...old, chatTitle: 'Chat title: Trip' })).toBe(false);
      expect(isFromCurrentChat({ ...old, chatTitle: 'Chat title: Taxes' })).toBe(false);
      expect(isFromCurrentChat({ ...old, chatTitle: undefined })).toBe(false);
      expect(isFromCurrentChat({ ...old, chatTitle: '' })).toBe(false);
    });

    it('trusts a recorded chat id over the title', () => {
      expect(
        isFromCurrentChat({ ...old, metadata: { session_id: 's2' }, chatTitle: 'Chat title: Trip planning' }),
      ).toBe(false);
    });
  });
});

describe('queryWords', () => {
  it('drops filler and acknowledgement words and repeats', () => {
    expect(queryWords('Yup')).toEqual([]);
    expect(queryWords('Anything? Sure, thanks, yes.')).toEqual([]);
    expect(queryWords('The dentist, the DENTIST and Rivera')).toEqual(['dentist', 'rivera']);
  });
});

describe('keywordMatches', () => {
  it('recalls nothing for a one-word reply', () => {
    expect(recalled('Yup')).toEqual([]);
    expect(recalled('Anything')).toEqual([]);
  });

  it('recalls nothing when a short reply sits on top of a chat that matches no note', () => {
    expect(recalled('Yup\n\nI said hello to the group\n\nSee you there')).toEqual([]);
  });

  it('does not let one common word pull in a note', () => {
    // "week" is in two of five notes, which is not rare, and no second word is shared.
    expect(recalled('This week')).toEqual([]);
  });

  it('recalls a clearly relevant question', () => {
    expect(recalled('Who is my dentist?')).toEqual([notes[2]?.text]);
    expect(recalled('What is the name of the vet for my dog Lexie')).toEqual([notes[0]?.text]);
  });

  it('recalls a note that shares two words even when both are common', () => {
    expect(recalled('flights for the week of Sep 22')).toEqual([notes[1]?.text]);
  });

  it('matches at the start of a word, so a fragment inside a longer word is not a match', () => {
    // "sent" is a word start in the last note but only an inside fragment in "presented" or "consent".
    const matches = keywordMatches({
      query: 'sent',
      notes: [{ text: 'Consent form presented today' }, { text: 'sent the form' }],
    });
    expect(matches.map(match => match.note.text)).toEqual(['sent the form']);
  });

  it('counts shared words so a stronger match can rank first', () => {
    const matches = keywordMatches({ query: 'dentist Rivera Tuesdays', notes });
    expect(matches).toEqual([{ note: notes[2], shared: 3 }]);
  });
});
