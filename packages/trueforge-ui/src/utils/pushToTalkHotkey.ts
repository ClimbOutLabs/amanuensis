import { createDisplayPreference } from './displayPreference.js';

/**
 * Keyboard shortcuts that can be held to talk. Each ends in Space with two modifiers, so none of
 * them types into the message box or clashes with common browser shortcuts.
 */
export const PUSH_TO_TALK_HOTKEYS = [
  { id: 'ctrl-shift-space', label: 'Ctrl + Shift + Space', ctrl: true, shift: true, alt: false },
  { id: 'alt-shift-space', label: 'Alt + Shift + Space', ctrl: false, shift: true, alt: true },
  { id: 'ctrl-alt-space', label: 'Ctrl + Alt + Space', ctrl: true, shift: false, alt: true },
] as const;

export type PushToTalkHotkey = (typeof PUSH_TO_TALK_HOTKEYS)[number];
export type PushToTalkHotkeyId = PushToTalkHotkey['id'] | 'off';

export const PUSH_TO_TALK_HOTKEY_STORAGE_KEY = 'aman.push_to_talk_hotkey';

export function isHotkeyId(value: string): value is PushToTalkHotkeyId {
  return value === 'off' || PUSH_TO_TALK_HOTKEYS.some(hotkey => hotkey.id === value);
}

const pushToTalkHotkey = createDisplayPreference<PushToTalkHotkeyId>({
  storageKey: PUSH_TO_TALK_HOTKEY_STORAGE_KEY,
  defaultValue: 'ctrl-shift-space',
  parse: stored => (isHotkeyId(stored) ? stored : undefined),
  serialize: id => id,
});

export function usePushToTalkHotkey(): {
  hotkeyId: PushToTalkHotkeyId;
  setHotkeyId: (id: PushToTalkHotkeyId) => void;
} {
  return { hotkeyId: pushToTalkHotkey.useValue(), setHotkeyId: pushToTalkHotkey.set };
}

export function hotkeyById(id: PushToTalkHotkeyId): PushToTalkHotkey | undefined {
  return PUSH_TO_TALK_HOTKEYS.find(hotkey => hotkey.id === id);
}

/** Whether a key press is the held shortcut. Meta (Cmd) must be up so system shortcuts pass. */
export function matchesHotkey(
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  hotkey: PushToTalkHotkey,
): boolean {
  return (
    event.code === 'Space' &&
    event.ctrlKey === hotkey.ctrl &&
    event.shiftKey === hotkey.shift &&
    event.altKey === hotkey.alt &&
    !event.metaKey
  );
}
