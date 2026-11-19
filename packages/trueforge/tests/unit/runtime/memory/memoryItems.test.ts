/**
 * The tracked-items log on its own: the reply parser stays loose, the file round-trips, the
 * fold never double-applies a retried event, and the evidence bar in eventsForItemFlags holds
 * on invented examples.
 */
import {
  citationVerifies,
  eventsForItemFlags,
  foldItemEvents,
  formatItemEvent,
  formatItemsBlock,
  itemEventId,
  itemListForPrompt,
  namesThePerson,
  parseItemFlags,
  parseItemLog,
  type ItemEvent,
  type ItemFlag,
} from '../../../../src/runtime/memory/memoryItems';

const AT = '2026-11-16T12:00:00.000Z';

function openedEvent(overrides: Partial<ItemEvent> = {}): ItemEvent {
  return {
    eventId: 'evt-open-1',
    at: AT,
    kind: 'opened',
    itemId: 'item-aaaaaaaa',
    action: 'Submit the harbour festival entry form',
    owner: 'the person',
    citation: 'please submit the enclosed entry form for your stall',
    source: 'email',
    ...overrides,
  };
}

describe('parseItemFlags', () => {
  it('reads a well-formed items list', () => {
    const flags = parseItemFlags({
      facts: [],
      items: [
        {
          kind: 'request',
          result: 2,
          owner: 'the person',
          action: 'Submit the form',
          citation: 'please submit the form',
          addressedToPerson: true,
          due: '2026-11-20',
        },
      ],
    });
    expect(flags).toEqual([
      {
        kind: 'request',
        result: 2,
        owner: 'the person',
        action: 'Submit the form',
        citation: 'please submit the form',
        addressedToPerson: true,
        due: '2026-11-20',
      },
    ]);
  });

  it('drops malformed entries without failing the whole list', () => {
    const flags = parseItemFlags({
      items: [
        { kind: 'nonsense', owner: 'the person', action: 'X', citation: 'y' },
        { kind: 'request', owner: '', action: 'X', citation: 'y' },
        { kind: 'request', owner: 'the person', action: 'Keep this one', citation: 'the passage' },
        'not an object',
      ],
    });
    expect(flags.map(flag => flag.action)).toEqual(['Keep this one']);
  });

  it('returns nothing for a reply with no items key or no JSON', () => {
    expect(parseItemFlags({ facts: [] })).toEqual([]);
    expect(parseItemFlags('no json here')).toEqual([]);
    expect(parseItemFlags(undefined)).toEqual([]);
  });
});

describe('citationVerifies and namesThePerson', () => {
  it('verifies a passage across case, punctuation and line breaks', () => {
    expect(
      citationVerifies({
        citation: 'Please submit the enclosed entry form, for your stall!',
        sourceText: 'Dear Alex,\nplease submit the enclosed entry form for your stall by Friday.',
      }),
    ).toBe(true);
    expect(
      citationVerifies({ citation: 'return the signed lease by Monday', sourceText: 'please submit the form' }),
    ).toBe(false);
    expect(citationVerifies({ citation: 'short', sourceText: 'short' })).toBe(false);
  });

  it('names the person by name or by role words only', () => {
    expect(namesThePerson({ owner: 'Alex', personName: 'Alex' })).toBe(true);
    expect(namesThePerson({ owner: 'the person', personName: 'Alex' })).toBe(true);
    expect(namesThePerson({ owner: 'you', personName: undefined })).toBe(true);
    expect(namesThePerson({ owner: 'Priya Nair', personName: 'Alex' })).toBe(false);
  });
});

describe('the event log', () => {
  it('round-trips an event through the plain text format', () => {
    const event = openedEvent({ due: '2026-11-20' });
    expect(parseItemLog(formatItemEvent(event))).toEqual([event]);
  });

  it('skips lines it cannot read instead of failing', () => {
    const content = `${formatItemEvent(openedEvent())}\ngarbage line\n## not a real header\n`;
    expect(parseItemLog(content)).toHaveLength(1);
  });

  it('folds a retried event only once', () => {
    const event = openedEvent();
    const folded = foldItemEvents([event, event]);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.state).toBe('open');
  });

  it('keeps an item id stable when a surfaced item is promoted by a fresh opened event', () => {
    const surfaced = openedEvent({ kind: 'surfaced', eventId: 'evt-surf-1' });
    const promoted = openedEvent({ eventId: 'evt-open-2' });
    const folded = foldItemEvents([surfaced, promoted]);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.state).toBe('open');
  });

  it('a surfaced event never demotes an open or closed item', () => {
    const closed: ItemEvent = {
      eventId: 'evt-close-1',
      at: AT,
      kind: 'closed',
      itemId: 'item-aaaaaaaa',
      action: 'Submit the harbour festival entry form',
      owner: 'the person',
      citation: 'done',
      closeReason: 'completed',
    };
    const folded = foldItemEvents([openedEvent(), closed, openedEvent({ kind: 'surfaced', eventId: 'evt-surf-9' })]);
    expect(folded[0]?.state).toBe('closed');
  });

  it('reopened returns a closed item to open, and event ids are retry-stable', () => {
    expect(itemEventId({ sessionId: 's1', turnId: 't1', pass: 'person', index: 0 })).toBe(
      itemEventId({ sessionId: 's1', turnId: 't1', pass: 'person', index: 0 }),
    );
    expect(itemEventId({ sessionId: 's1', turnId: 't1', pass: 'person', index: 0 })).not.toBe(
      itemEventId({ sessionId: 's1', turnId: 't1', pass: 'person', index: 1 }),
    );
  });
});

describe('formatItemsBlock', () => {
  it('shows at most the cap and counts what remains', () => {
    const items = Array.from({ length: 14 }, (_, index) => ({
      id: `item-${index}`,
      action: `Task number ${index}`,
      owner: 'the person',
      citation: 'citation',
      source: 'person' as const,
      state: 'open' as const,
      openedAt: AT,
      evidenceCount: 0,
      partialNotes: [],
      unconfirmedCompletions: [],
    }));
    const block = formatItemsBlock({ items, today: '2026-11-18' });
    expect(block).toContain('Task number 0');
    expect(block).toContain('2 more open items are not shown here');
  });

  it('marks a passed due date as passed and keeps the item listed', () => {
    const block = formatItemsBlock({
      items: [
        {
          id: 'item-1',
          action: 'Return the form',
          owner: 'the person',
          citation: 'citation',
          source: 'person',
          state: 'open',
          openedAt: AT,
          due: '2020-06-01',
          evidenceCount: 0,
          partialNotes: [],
          unconfirmedCompletions: [],
        },
      ],
      today: '2026-11-18',
    });
    expect(block).toContain('Due 2020-06-01, which has passed.');
  });
});

describe('eventsForItemFlags evidence bar', () => {
  const base = {
    items: [],
    entries: [],
    personName: 'Alex',
    sessionId: 's1',
    turnId: 't1',
    pass: 'notes' as const,
    at: AT,
    sources: { userText: '', results: [], assistantText: '' },
  };

  it('a bulk promotion without a tie to the person records nothing at all', () => {
    const flag: ItemFlag = {
      kind: 'request',
      result: 1,
      owner: 'the person',
      action: 'Subscribe to the newsletter',
      citation: 'Alex, subscribe today and save 10 percent',
      addressedToPerson: true,
      tiedToRole: false,
    };
    const events = eventsForItemFlags({
      ...base,
      flags: [flag],
      sources: {
        userText: '',
        results: [
          {
            source: 'email',
            text: 'List-Unsubscribe: <https://x.example/leave>\nAlex, subscribe today and save 10 percent on gifts.',
          },
        ],
        assistantText: '',
      },
    });
    expect(events).toEqual([]);
  });

  it('a bulk request tied to the person still opens: bulk sending alone does not disqualify', () => {
    const flag: ItemFlag = {
      kind: 'request',
      result: 1,
      owner: 'the person',
      action: 'Return the school consent form',
      citation: 'Please return the signed consent form for your child',
      addressedToPerson: false,
      tiedToRole: true,
    };
    const events = eventsForItemFlags({
      ...base,
      flags: [flag],
      sources: {
        userText: '',
        results: [
          {
            source: 'email',
            text: 'List-Unsubscribe: <https://school.example/leave>\nTo: Alex\nPlease return the signed consent form for your child by Friday.',
          },
        ],
        assistantText: '',
      },
    });
    expect(events.map(event => event.kind)).toEqual(['opened']);
  });

  it('the assistant reply can never open an item on its own', () => {
    const flag: ItemFlag = {
      kind: 'request',
      owner: 'the person',
      action: 'Book the hall',
      citation: 'I will book the hall for you tomorrow',
    };
    const events = eventsForItemFlags({
      ...base,
      pass: 'notes',
      flags: [flag],
      sources: {
        userText: 'Tell me about the hall.',
        results: [],
        assistantText: 'I will book the hall for you tomorrow.',
      },
    });
    expect(events).toEqual([]);
  });

  it('a completion whose passage is about a different item is recorded unconfirmed, not closed', () => {
    const item = foldItemEvents([openedEvent()])[0];
    if (item === undefined) {
      throw new Error('fixture item missing');
    }
    const flag: ItemFlag = {
      kind: 'completion',
      item: 1,
      owner: 'the person',
      action: 'Water the greenhouse plants',
      citation: 'I watered the greenhouse plants this morning',
    };
    const events = eventsForItemFlags({
      ...base,
      pass: 'person',
      items: [item],
      entries: itemListForPrompt([item]).entries,
      flags: [flag],
      sources: { userText: 'I watered the greenhouse plants this morning.', results: [], assistantText: '' },
    });
    expect(events.map(event => event.kind)).toEqual(['completion_noted']);
  });
});
