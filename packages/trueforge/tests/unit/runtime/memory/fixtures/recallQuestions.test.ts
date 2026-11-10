import { QUERY_STOPWORDS } from '../../../../../src/runtime/memory/stopWords';
import { MAYA_ENTRIES, MAYA_STORY_IDS } from '../../../../fixtures/memory/mayaWorld/entries';
import { MAYA_EVENTS } from '../../../../fixtures/memory/mayaWorld/events';
import { MAYA_RECALL_QUESTIONS } from '../../../../fixtures/memory/mayaWorld/recallQuestions';
import { RECALL_CATEGORIES } from '../../../../fixtures/memory/mayaWorld/schema';

interface Source {
  day: number;
  text: string;
  madeAChange: boolean;
}

function sourceOf(id: string): Source | undefined {
  const eventDay = /^event:(\d+)$/.exec(id)?.[1];
  if (eventDay !== undefined) {
    const event = MAYA_EVENTS.find(candidate => candidate.day === Number(eventDay));
    return event === undefined ? undefined : { day: event.day, text: event.after_line, madeAChange: true };
  }
  const entry = MAYA_ENTRIES.find(candidate => candidate.id === id);
  return entry === undefined
    ? undefined
    : {
        day: entry.day,
        text: entry.content,
        madeAChange: entry.expected.some(decision => decision.decision === 'changed'),
      };
}

/** The words of a text that say what it is about. */
function topicWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter(word => word.length > 2 && !QUERY_STOPWORDS.has(word)));
}

function within({ text, phrase }: { text: string; phrase: string }): boolean {
  return text.toLowerCase().includes(phrase.toLowerCase());
}

describe("recall questions over Maya's world", () => {
  const noise = MAYA_ENTRIES.filter(entry => !MAYA_STORY_IDS.has(entry.id));

  it('has enough questions of every kind', () => {
    expect(new Set(MAYA_RECALL_QUESTIONS.map(question => question.id)).size).toBe(MAYA_RECALL_QUESTIONS.length);
    for (const category of RECALL_CATEGORIES) {
      expect(MAYA_RECALL_QUESTIONS.filter(question => question.category === category).length).toBeGreaterThanOrEqual(4);
    }
    const changed = MAYA_RECALL_QUESTIONS.filter(question => question.category === 'current_value_of_changed_fact');
    expect(changed.length).toBeGreaterThanOrEqual(10);
    expect(changed.every(question => question.must_not_text !== undefined)).toBe(true);
    expect(MAYA_RECALL_QUESTIONS.filter(question => question.category === 'no_name_in_message')).toEqual(
      expect.arrayContaining([expect.objectContaining({ earlier_messages: [expect.any(String)] })]),
    );
  });

  it.each(MAYA_RECALL_QUESTIONS.map(question => [question.id, question] as const))(
    '%s is answered by its sources and by nothing else',
    (_id, question) => {
      const sources = question.source_entry_ids.map(sourceOf);
      expect(sources).not.toContain(undefined);
      const known = sources.flatMap(source => (source === undefined ? [] : [source]));
      expect(known.every(source => source.day <= question.as_of_day)).toBe(true);

      const expected = question.expected_text;
      if (expected !== undefined) {
        expect(known.some(source => within({ text: source.text, phrase: expected }))).toBe(true);
        // Everyday noise must not hold the answer, or a find would prove nothing.
        expect(noise.filter(entry => within({ text: entry.content, phrase: expected }))).toEqual([]);
      }
      const unwanted = question.must_not_text;
      if (unwanted !== undefined) {
        expect(noise.filter(entry => within({ text: entry.content, phrase: unwanted }))).toEqual([]);
        if (expected !== undefined) {
          // The right answer must be showable without the unwanted text riding along in the same entry.
          expect(
            known.some(
              source =>
                within({ text: source.text, phrase: expected }) && !within({ text: source.text, phrase: unwanted }),
            ),
          ).toBe(true);
        }
      }
      if (question.category === 'current_value_of_changed_fact') {
        expect(known.some(source => source.madeAChange)).toBe(true);
      }
      if (question.category === 'asked_in_other_words') {
        // Word search must have nothing to hold on to: only the meaning links the question to its answer.
        const asked = topicWords(question.message);
        for (const source of known) {
          expect([...topicWords(source.text)].filter(word => asked.has(word))).toEqual([]);
        }
      }
      if (question.category === 'nothing_to_recall') {
        // Not one entry of the world is about the message, on any day.
        const asked = topicWords(question.message);
        expect(
          MAYA_ENTRIES.filter(entry => [...topicWords(entry.content)].some(word => asked.has(word))).map(
            entry => entry.id,
          ),
        ).toEqual([]);
      }
    },
  );
});
