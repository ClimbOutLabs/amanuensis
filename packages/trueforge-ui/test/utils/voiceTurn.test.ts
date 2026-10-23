import { afterEach, describe, expect, it } from 'vitest';

import {
  armSpokenReply,
  clearDraftFromVoice,
  disarmSpokenReply,
  markDraftFromVoice,
  noteUserMessage,
  takeDraftFromVoice,
  takeSpokenReply,
} from '@/utils/voiceTurn.js';

describe('voice turn tracking', () => {
  afterEach(() => {
    clearDraftFromVoice();
    disarmSpokenReply();
  });

  it('marks a draft from voice once, and taking it resets the mark', () => {
    markDraftFromVoice();

    expect(takeDraftFromVoice()).toBe(true);
    expect(takeDraftFromVoice()).toBe(false);
  });

  it('clears the voice mark when the composer is emptied', () => {
    markDraftFromVoice();
    clearDraftFromVoice();

    expect(takeDraftFromVoice()).toBe(false);
  });

  it('reads the reply to the voice message once its turn finishes', () => {
    armSpokenReply({ fromVoice: true, text: 'What is on my calendar?' });
    noteUserMessage({ id: 'user-1', text: 'What is on my calendar?' });

    expect(takeSpokenReply('user-1')).toBe(true);
    expect(takeSpokenReply('user-1')).toBe(false);
  });

  it('does not read a reply to a typed message', () => {
    armSpokenReply({ fromVoice: false, text: 'typed words' });
    noteUserMessage({ id: 'user-1', text: 'typed words' });

    expect(takeSpokenReply('user-1')).toBe(false);
  });

  // The blocker: a voice send that failed left its flag set, so a later run read aloud.
  it('does not read the reply to a later message after a voice send failed', () => {
    armSpokenReply({ fromVoice: true, text: 'spoken words' });
    disarmSpokenReply();
    noteUserMessage({ id: 'user-2', text: 'Edited answer' });

    expect(takeSpokenReply('user-2')).toBe(false);
  });

  it('ends a voice send that is still waiting when another message arrives first', () => {
    armSpokenReply({ fromVoice: true, text: 'spoken words' });
    noteUserMessage({ id: 'user-2', text: 'Edited answer' });
    noteUserMessage({ id: 'user-3', text: 'spoken words' });

    expect(takeSpokenReply('user-3')).toBe(false);
  });

  it('does not read a voice message again once its reply was taken', () => {
    armSpokenReply({ fromVoice: true, text: 'spoken words' });
    noteUserMessage({ id: 'user-1', text: 'spoken words' });
    expect(takeSpokenReply('user-1')).toBe(true);

    expect(takeSpokenReply('user-1')).toBe(false);
  });

  it('lets a new send replace a voice send still waiting for its message', () => {
    armSpokenReply({ fromVoice: true, text: 'first try' });
    armSpokenReply({ fromVoice: false, text: 'typed instead' });
    noteUserMessage({ id: 'user-1', text: 'first try' });

    expect(takeSpokenReply('user-1')).toBe(false);
  });
});
