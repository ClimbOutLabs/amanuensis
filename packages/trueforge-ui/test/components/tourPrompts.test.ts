import { MORNING_BRIEF_CARD_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { HELP_AREA_IDS } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';
import { describe, expect, it } from 'vitest';

import {
  CARDS,
  composerTextFor,
  DEFAULT_CARD_KEYS,
  HELP_AREA_TOPIC,
  HOME_CARD_COUNT,
  HOME_TOPIC_IDS,
  HOME_TOPICS,
  homeCardsFor,
  homeSlotsFor,
  isHomeTopicId,
  RUN_BRIEF_CARD,
  visibleTourCards,
  type TourCapabilities,
  type TourCard,
} from '@/components/tourPrompts.js';

const none: TourCapabilities = { email: false, calendar: false, sandbox: false, maps: false };
const connected: TourCapabilities = { email: true, calendar: true, sandbox: false, maps: false };
const all: TourCapabilities = { email: true, calendar: true, sandbox: true, maps: true };

const titlesOf = (cards: readonly TourCard[]) => cards.map(card => card.title);
const everyCard: readonly TourCard[] = Object.values(CARDS);

describe('visibleTourCards', () => {
  const card = (title: string, needs?: TourCard['needs']): TourCard => ({
    title,
    detail: () => '',
    prompt: title,
    icon: 'clock',
    ...(needs === undefined ? {} : { needs }),
  });

  it('keeps the cards that need nothing, and the ones whose capability is granted', () => {
    const items = [card('always'), card('mail', ['email'])];
    expect(titlesOf(visibleTourCards(items, none))).toEqual(['always']);
    expect(titlesOf(visibleTourCards(items, { ...none, email: true }))).toEqual(['always', 'mail']);
  });

  it('keeps a card that needs calendar or email when either one is granted', () => {
    const items = [card('either', ['calendar', 'email'])];
    expect(visibleTourCards(items, { ...none, calendar: true })).toHaveLength(1);
    expect(visibleTourCards(items, { ...none, email: true })).toHaveLength(1);
    expect(visibleTourCards(items, none)).toHaveLength(0);
  });
});

describe('the pills', () => {
  it('come in the agreed order, with the old labels retired', () => {
    expect(HOME_TOPIC_IDS.map(id => HOME_TOPICS[id].label)).toEqual([
      "I'm behind",
      "Something's coming up",
      'I need to write something hard',
      'Help me think',
      'Someone I look after',
      'Money',
      'I just moved here',
    ]);
    const labels = HOME_TOPIC_IDS.map(id => HOME_TOPICS[id].label);
    for (const retired of ['Productivity', 'Family and home', 'New to a country']) {
      expect(labels).not.toContain(retired);
    }
  });

  it('read an old stored pill as no pill', () => {
    for (const old of ['productivity', 'family', 'new_country', '']) expect(isHomeTopicId(old)).toBe(false);
    for (const id of HOME_TOPIC_IDS) expect(isHomeTopicId(id)).toBe(true);
  });

  it('are lists of card keys, and a card under two pills is one definition', () => {
    const shared = HOME_TOPICS.behind.cards.filter(key => HOME_TOPICS.help_me_think.cards.includes(key));
    expect(shared).toEqual(['head']);
    const behind = homeCardsFor({ topic: 'behind', capabilities: none });
    const think = homeCardsFor({ topic: 'help_me_think', capabilities: none });
    const behindHead = behind.find(card => card.title === CARDS.head.title);
    const thinkHead = think.find(card => card.title === CARDS.head.title);
    expect(behindHead).toBe(CARDS.head);
    expect(thinkHead).toBe(CARDS.head);
  });

  it('name only cards that exist, with no card repeated in one list', () => {
    for (const keys of [DEFAULT_CARD_KEYS, ...HOME_TOPIC_IDS.map(id => HOME_TOPICS[id].cards)]) {
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) expect(CARDS[key]).toBeDefined();
    }
  });
});

describe('homeCardsFor', () => {
  it('shows head, start, kindly and dinner on a fresh install', () => {
    expect(titlesOf(homeCardsFor({ topic: null, capabilities: none }))).toEqual([
      CARDS.head.title,
      CARDS.start.title,
      CARDS.kindly.title,
      CARDS.dinner.title,
    ]);
  });

  it('shows brief, today, dropping and head with email and calendar connected', () => {
    expect(titlesOf(homeCardsFor({ topic: null, capabilities: connected }))).toEqual([
      CARDS.brief.title,
      CARDS.today.title,
      CARDS.dropping.title,
      CARDS.head.title,
    ]);
  });

  it('skips a card whose needs are not met and fills from the next ones', () => {
    const calendarOnly = { ...none, calendar: true };
    expect(titlesOf(homeCardsFor({ topic: null, capabilities: calendarOnly }))).toEqual([
      CARDS.brief.title,
      CARDS.today.title,
      CARDS.head.title,
      CARDS.start.title,
    ]);
  });

  it('gives every pill four cards with everything connected, and what has no needs on a fresh install', () => {
    const fresh = {
      behind: 2,
      coming_up: 3,
      write_hard: 4,
      help_me_think: 4,
      someone_i_look_after: 4,
      money: 3,
      just_moved: 4,
    };
    for (const topic of HOME_TOPIC_IDS) {
      const connectedCards = homeCardsFor({ topic, capabilities: all });
      expect(connectedCards, topic).toHaveLength(HOME_CARD_COUNT);
      expect(new Set(titlesOf(connectedCards)).size).toBe(HOME_CARD_COUNT);
      const freshCards = homeCardsFor({ topic, capabilities: none });
      expect(freshCards, `${topic} on a fresh install`).toHaveLength(fresh[topic]);
      for (const card of freshCards) expect(card.needs).toBeUndefined();
    }
  });

  it('works without needs on a fresh install for the default cards that have none', () => {
    for (const card of homeCardsFor({ topic: null, capabilities: none })) expect(card.needs).toBeUndefined();
  });
});

describe('card text', () => {
  it('puts only the card prompt in the composer, with nothing added under it', () => {
    for (const card of everyCard) {
      expect(composerTextFor(card)).toBe(card.prompt);
    }
  });

  it('fills the morning brief card prompt for the brief card', () => {
    expect(CARDS.brief.prompt).toBe(MORNING_BRIEF_CARD_PROMPT);
    expect(composerTextFor(CARDS.brief)).toBe(MORNING_BRIEF_CARD_PROMPT);
  });

  it('writes every card in plain words, names the assistant only through its display name, and uses no dashes', () => {
    for (const card of everyCard) {
      const detail = card.detail('Juniper');
      expect(detail).not.toMatch(/\b(Aman|Mannie)\b/);
      expect(composerTextFor(card)).not.toMatch(/\b(Aman|Mannie)\b/);
      for (const text of [detail, card.title, card.prompt]) expect(text).not.toContain('\u2014');
    }
  });

  it('gives no two cards the same title', () => {
    const titles = titlesOf(everyCard);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('uses only icons from the existing set', () => {
    const allowed = new Set([
      'book-open',
      'calendar',
      'calendar-clock',
      'calendar-plus',
      'chart',
      'circle-check',
      'clock',
      'clock-rotate-left',
      'dollar-sign',
      'file',
      'folder',
      'lightbulb',
      'list-check',
      'map-pin',
      'message-square-text',
      'play',
      'search',
      'sliders',
      'square-pen',
      'broom',
    ]);
    for (const card of everyCard) expect(allowed.has(card.icon), card.title).toBe(true);
  });
});

describe('the rewritten cards', () => {
  it('carries none of the shared rules lines that were taken out, on any card', () => {
    const removed = [
      'Plain words and short replies',
      'Ask one thing at a time when you need answers',
      'If you have to assume something, say what it is in one line',
      'Never send, save, book, cancel, or change anything without asking me first',
      'ask with the exact thing you are about to do',
    ];
    for (const card of everyCard) {
      for (const line of removed) expect(composerTextFor(card), card.title).not.toContain(line);
    }
  });

  it('carries no act-first or latest-message-wins line on any card', () => {
    for (const card of everyCard) {
      expect(card.prompt, card.title).not.toContain('do that first');
      expect(card.prompt, card.title).not.toContain('latest message wins');
    }
  });

  it('states the ask first on every card, asks once, and uses no dashes, so the model acts instead of asking what to do', () => {
    // The brief card opens with the line the brief schedule is recognised by, so it is checked on its own.
    const cards = everyCard.filter(card => card !== CARDS.brief);
    for (const card of cards) {
      expect(card.prompt, card.title).toMatch(/^I /);
      expect(card.prompt, card.title).not.toContain(' - ');
      expect(card.prompt, card.title).not.toContain('\u2014');
      if (/\bask me\b/i.test(card.prompt)) expect(card.prompt, card.title).toContain('one short message');
      expect(card.prompt, card.title).not.toMatch(/one (thing|field|line|word) at a time|line by line|in one line/i);
    }
    expect(CARDS.brief.prompt).toBe(MORNING_BRIEF_CARD_PROMPT);
    expect(CARDS.say_no.prompt).toMatch(/^I need to say no to something\. In one short message, ask me/);
    for (const card of [CARDS.say_no, CARDS.ask_for, CARDS.thanks]) {
      expect(card.prompt, card.title).toContain('Show me the draft and wait for my OK');
    }
    expect(CARDS.follow_up.prompt).toContain('Wait for my OK before sending');
  });

  it('waits for my OK on every card whose prompt sends, saves, sets or books', () => {
    for (const card of everyCard) {
      if (/\b(save|saving|saved|send|sending|sent|book|booking|set it|set them|set that)\b/i.test(card.prompt)) {
        expect(card.prompt, card.title).toMatch(/\bask|after I say yes|wait(ing)? for my OK|asking me/i);
      }
    }
  });

  it('asks before saving the dinner plan', () => {
    expect(CARDS.dinner.prompt).toContain('Offer to save the plan where I can tick it off');
    expect(CARDS.dinner.prompt).toContain('only after I say yes');
  });

  it('asks who is eating and about allergies on the dinner card, when that is not known', () => {
    expect(CARDS.dinner.prompt).toContain('who is eating');
    expect(CARDS.dinner.prompt).toContain('unless you already know');
    expect(CARDS.dinner.prompt).toContain("an allergy or a food they won't eat");
  });

  it('starts the dinner card with the plan, not a round of questions', () => {
    expect(CARDS.dinner.prompt).toMatch(/^I want this week's dinners planned, with one shopping list grouped by aisle/);
    expect(CARDS.dinner.prompt).not.toContain('Ask me how many people are eating');
  });

  it('asks only for what the trip checklist needs', () => {
    expect(CARDS.trip.prompt).toContain('ask me where I am going and when');
    expect(CARDS.trip.prompt).not.toContain('sort out the week before');
  });

  it('fits the trip checklist to the time left', () => {
    expect(CARDS.trip.prompt).toContain('what to book, what to sort out before I go, and what to pack');
    expect(CARDS.trip.prompt).toContain('in the right order for the time I have left');
  });

  it('does not presume my answers on the trip card or defend against them', () => {
    expect(CARDS.trip.prompt).not.toContain('short or joking');
    expect(CARDS.trip.prompt).not.toContain('Never ask the same thing twice');
  });

  it('makes the start card one small first step, with no check-back script', () => {
    expect(CARDS.start.prompt).toContain('one small first step I could do in about ten minutes');
    expect(CARDS.start.prompt).toContain('make the step smaller without making a fuss');
    expect(CARDS.start.prompt).not.toContain('check back in 30 minutes');
    expect(CARDS.start.prompt).not.toContain('two lines');
    expect(CARDS.start.prompt).not.toContain('two minutes');
  });

  it('lets the talk card listen, with advice only when it is asked for', () => {
    expect(CARDS.talk.prompt).toContain("If I want advice, I'll ask for it");
    expect(CARDS.talk.prompt).not.toContain('Do not give advice unless I ask for it');
    expect(CARDS.talk.prompt).not.toContain('two or three lines');
  });

  it('keeps the company card quiet without sealing it shut', () => {
    expect(CARDS.company.prompt).toContain('stay quiet unless I speak to you');
    expect(CARDS.company.prompt).not.toContain('nothing else');
    expect(CARDS.company.prompt).not.toContain('Never add tips or encouragement');
  });

  it('lays the decide options side by side without scripting the ending', () => {
    expect(CARDS.decide.prompt).toContain('lay the options out side by side');
    expect(CARDS.decide.prompt).not.toContain('three questions at most');
    expect(CARDS.decide.prompt).not.toContain('Then stop');
  });
});

describe('help areas', () => {
  it('map to the pills in one table, one entry for each saved help area', () => {
    expect(HELP_AREA_TOPIC).toEqual({
      focus: 'help_me_think',
      family: 'someone_i_look_after',
      caring: 'someone_i_look_after',
      new_country: 'just_moved',
      work_money: 'money',
    });
    expect(Object.keys(HELP_AREA_TOPIC).sort()).toEqual([...HELP_AREA_IDS].sort());
    for (const topic of Object.values(HELP_AREA_TOPIC)) expect(isHomeTopicId(topic)).toBe(true);
  });
});

describe('homeSlotsFor', () => {
  const titles = (slots: ReturnType<typeof homeSlotsFor>) => slots.map(slot => slot.card.title);

  it('puts the run my daily brief card just after the morning brief card, at the same count', () => {
    const slots = homeSlotsFor({ topic: null, capabilities: connected, briefRun: true });

    expect(slots).toHaveLength(HOME_CARD_COUNT);
    expect(titles(slots).slice(0, 2)).toEqual([CARDS.brief.title, RUN_BRIEF_CARD.title]);
    expect(slots[1]?.kind).toBe('run_brief');
  });

  it('puts the run card first when the morning brief card is hidden', () => {
    const slots = homeSlotsFor({ topic: null, capabilities: none, briefRun: true });

    expect(slots[0]?.kind).toBe('run_brief');
    expect(slots).toHaveLength(HOME_CARD_COUNT);
  });

  it('leaves the run card out without a brief schedule, and under other pills', () => {
    expect(
      homeSlotsFor({ topic: null, capabilities: connected, briefRun: false }).map(slot => slot.kind),
    ).not.toContain('run_brief');
    expect(titles(homeSlotsFor({ topic: 'money', capabilities: connected, briefRun: true }))).toEqual(
      titlesOf(homeCardsFor({ topic: 'money', capabilities: connected })),
    );
  });

  it("puts the run card first under I'm behind, at the same count", () => {
    const slots = homeSlotsFor({ topic: 'behind', capabilities: connected, briefRun: true });

    expect(slots[0]?.kind).toBe('run_brief');
    expect(slots).toHaveLength(HOME_CARD_COUNT);
    expect(titles(slots).slice(1)).toEqual(
      titlesOf(homeCardsFor({ topic: 'behind', capabilities: connected })).slice(0, HOME_CARD_COUNT - 1),
    );
  });

  it('describes the run card in plain words, with no assistant name and no dashes', () => {
    const detail = RUN_BRIEF_CARD.detail('Juniper');
    expect(RUN_BRIEF_CARD.title).toBe('Run my daily brief');
    expect(detail).toBe('Runs your scheduled brief now');
    for (const text of [detail, RUN_BRIEF_CARD.title]) expect(text).not.toMatch(/\b(Aman|Mannie)\b|\u2014/);
  });
});
