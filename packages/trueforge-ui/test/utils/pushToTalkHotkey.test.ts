import { describe, expect, it } from 'vitest';

import { hotkeyById, isHotkeyId, matchesHotkey } from '@/utils/pushToTalkHotkey.js';

const press = { code: 'Space', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };

describe('pushToTalkHotkey', () => {
  it('matches only the exact keys of the chosen shortcut', () => {
    const hotkey = hotkeyById('ctrl-shift-space');
    if (hotkey === undefined) throw new Error('missing hotkey');
    expect(matchesHotkey(press, hotkey)).toBe(true);
    expect(matchesHotkey({ ...press, altKey: true }, hotkey)).toBe(false);
    expect(matchesHotkey({ ...press, metaKey: true }, hotkey)).toBe(false);
    expect(matchesHotkey({ ...press, code: 'KeyA' }, hotkey)).toBe(false);
  });

  it('has no shortcut when switched off and rejects unknown stored values', () => {
    expect(hotkeyById('off')).toBeUndefined();
    expect(isHotkeyId('off')).toBe(true);
    expect(isHotkeyId('ctrl-alt-space')).toBe(true);
    expect(isHotkeyId('f13')).toBe(false);
  });
});
