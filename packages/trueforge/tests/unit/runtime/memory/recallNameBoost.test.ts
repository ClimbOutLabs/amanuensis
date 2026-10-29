import { namedPeopleInMessage, rankNamedPeopleFirst } from '../../../../src/runtime/memory/recallNameBoost';

const MESSAGE =
  "Hi June, remember Wendy's is coming up in December in India and I wont be able to attend. Can you come up with 3 gift ideas and create a space for me";

describe('namedPeopleInMessage', () => {
  it('finds capitalized words mid-sentence and skips the sentence opener and the month', () => {
    expect(namedPeopleInMessage(MESSAGE)).toEqual(['Wendy', 'India']);
  });

  it('skips the pronoun I, a single capital letter, and words that open a sentence', () => {
    expect(namedPeopleInMessage('Can you help? I think so. A plan for Monday.')).toEqual([]);
  });

  it('skips capitals inside a word and after an apostrophe', () => {
    expect(namedPeopleInMessage("we met at McDonald's")).toEqual([]);
  });

  it('skips short months and weekdays', () => {
    expect(namedPeopleInMessage('Remind me on Oct 5, Sept 9 and Tues about Wendy')).toEqual(['Wendy']);
  });

  it('keeps at most 15 names', () => {
    const letters = 'abcdefghijklmnopqrst'.split('').map(c => `X${c.repeat(2)}`);
    expect(namedPeopleInMessage(`Ask ${letters.join(' ')}`)).toEqual(letters.slice(0, 15));
  });

  it('finds nothing in a lowercase message', () => {
    expect(namedPeopleInMessage('remind me about the wendy trip in december')).toEqual([]);
  });
});

describe('rankNamedPeopleFirst', () => {
  const candidates = [
    { id: 'a', text: 'Photo gear for Lisbon: a light tripod and two lenses.' },
    { id: 'b', text: 'Rental budget for the autumn is tight.' },
    { id: 'c', text: "Maya's really good friend is Wendy." },
    { id: 'd', text: 'Fado nights are on Thursdays.' },
    { id: 'e', text: "Maya won't be able to attend Wendy's in December 2026 in India." },
  ];

  it('moves notes naming a person from the message ahead of the rest, keeping each group in order', () => {
    expect(rankNamedPeopleFirst({ candidates, message: MESSAGE }).map(item => item.id)).toEqual([
      'c',
      'e',
      'a',
      'b',
      'd',
    ]);
  });

  it('keeps the old order when the message names nobody', () => {
    expect(
      rankNamedPeopleFirst({ candidates, message: 'what did I say about the rental budget?' }).map(item => item.id),
    ).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('does not fire on a lowercase common word that a note also contains', () => {
    expect(
      rankNamedPeopleFirst({ candidates, message: 'I want to attend a fado night in december' }).map(item => item.id),
    ).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('matches the name as a whole word, not inside another word', () => {
    const items = [{ text: 'The Wendys burger chain opened downtown.' }, { text: 'Wendy called back.' }];
    expect(rankNamedPeopleFirst({ candidates: items, message: 'Did Wendy call?' })).toEqual([items[1], items[0]]);
  });

  it('does not boost a note only because it mentions a short month', () => {
    const items = [{ text: 'Fado night was great.' }, { text: 'The deadline moves to Oct 5.' }];
    expect(rankNamedPeopleFirst({ candidates: items, message: 'Is it due on Oct 5' })).toEqual(items);
  });

  it('still boosts a note that names one of the capped people', () => {
    const items = [{ text: 'Nothing here.' }, { text: 'Xaa called.' }];
    expect(rankNamedPeopleFirst({ candidates: items, message: 'Ask Xaa Xbb' })).toEqual([items[1], items[0]]);
  });
});
