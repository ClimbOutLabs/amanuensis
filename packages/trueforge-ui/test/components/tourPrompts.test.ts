import { describe, expect, it } from 'vitest';

import {
  GENERAL_CARDS,
  HOME_CARD_COUNT,
  HOME_TOPIC_IDS,
  HOME_TOPICS,
  homeCardsFor,
  visibleTourPrompts,
  type TourCapabilities,
  type TourPrompt,
} from '@/components/tourPrompts.js';

const none: TourCapabilities = { email: false, calendar: false, sandbox: false, maps: false };
const all: TourCapabilities = { email: true, calendar: true, sandbox: true, maps: true };

describe('visibleTourPrompts', () => {
  const card = (key: string, needs?: TourPrompt['needs']): TourPrompt => ({
    key,
    title: key,
    detail: () => '',
    prompt: key,
    source: key,
    output: key,
    icon: 'clock',
    ...(needs === undefined ? {} : { needs }),
  });

  it('keeps the examples that need nothing, and the ones whose capability is granted', () => {
    const items = [card('always'), card('mail', ['email'])];
    expect(visibleTourPrompts(items, none).map(item => item.key)).toEqual(['always']);
    expect(visibleTourPrompts(items, { ...none, email: true }).map(item => item.key)).toEqual(['always', 'mail']);
  });
});

describe('homeCardsFor', () => {
  it('shows the general set when no topic is chosen', () => {
    expect(homeCardsFor({ topic: null, capabilities: none })).toEqual(GENERAL_CARDS);
  });

  it('gives every topic four cards with no capabilities and with all of them, and no repeated key', () => {
    for (const topic of HOME_TOPIC_IDS) {
      for (const capabilities of [none, all]) {
        const keys = homeCardsFor({ topic, capabilities }).map(card => card.key);
        expect(keys).toHaveLength(HOME_CARD_COUNT);
        expect(new Set(keys).size).toBe(keys.length);
      }
    }
  });

  it('writes every card in plain words and names the assistant only through its display name', () => {
    for (const topic of HOME_TOPIC_IDS) {
      for (const card of HOME_TOPICS[topic].cards) {
        const detail = card.detail('Juniper');
        expect(detail).not.toMatch(/\b(Aman|Mannie)\b/);
        expect(detail).not.toContain('—');
        expect(card.title).not.toContain('—');
      }
    }
  });

  it('gives no two cards in an area the same title', () => {
    for (const cards of [GENERAL_CARDS, ...HOME_TOPIC_IDS.map(topic => HOME_TOPICS[topic].cards)]) {
      const titles = cards.map(card => card.title);
      expect(new Set(titles).size, titles.join(', ')).toBe(titles.length);
    }
  });

  it('keeps one plan-my-day card, never a second plan with another name', () => {
    const titles = HOME_TOPIC_IDS.flatMap(topic => HOME_TOPICS[topic].cards.map(card => card.title));
    expect(titles).not.toContain('Plan a calm day');
    expect(titles).not.toContain('Plan your day');
  });
});

describe('card prompts', () => {
  const everyCard = [GENERAL_CARDS, ...HOME_TOPIC_IDS.map(topic => HOME_TOPICS[topic].cards)].flat();

  it('name what to look at and what to produce, in the prompt itself', () => {
    for (const card of everyCard) {
      const prompt = card.prompt.toLowerCase();
      expect(card.source.trim(), `${card.key} names a source`).not.toBe('');
      expect(card.output.trim(), `${card.key} names an output`).not.toBe('');
      expect(prompt, `${card.key} prompt names its source`).toContain(card.source.toLowerCase());
      expect(prompt, `${card.key} prompt names its output`).toContain(card.output.toLowerCase());
    }
  });

  it('are written in plain words without dashes or the assistant name', () => {
    for (const card of everyCard) {
      expect(card.prompt).not.toMatch(/\b(Aman|Mannie)\b/);
      expect(card.prompt).not.toContain('\u2014');
    }
  });
});
