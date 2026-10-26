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
  isHomeTopicId,
  SHARED_RULES,
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
  it('puts the shared rules under every card prompt after a blank line', () => {
    for (const card of everyCard) {
      if (card.sharedRules === false) continue;
      expect(composerTextFor(card)).toBe(`${card.prompt}\n\n${SHARED_RULES}`);
    }
  });

  it('fills only the morning brief card prompt for the brief card, with no rules', () => {
    expect(CARDS.brief.prompt).toBe(MORNING_BRIEF_CARD_PROMPT);
    expect(composerTextFor(CARDS.brief)).toBe(MORNING_BRIEF_CARD_PROMPT);
    expect(everyCard.filter(card => card.sharedRules === false)).toEqual([CARDS.brief]);
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
