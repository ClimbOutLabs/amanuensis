'use client';

import { useAui } from '@assistant-ui/react';

import type { DraftComposerAction } from '../atoms/draft/DraftComposerActionsMenu.js';
import { useToasterOptional } from '../containers/ToasterContainer.js';

const PASTE_FAILED_TITLE = 'Could not paste';
const PASTE_FAILED_MESSAGE = 'Allow this site to see your clipboard, or paste into the message box with Ctrl+V.';

function canReadClipboard(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function';
}

/** Adds clipboard text to the end of the draft, on its own line when the draft already has text. */
export function appendPasted(current: string, pasted: string): string {
  if (pasted === '') return current;
  if (current.trim() === '') return pasted;
  return current.endsWith('\n') ? `${current}${pasted}` : `${current}\n${pasted}`;
}

/**
 * The `+` menu items that put something in the message: attaching files, and pasting from the
 * clipboard (for people who cannot easily use the keyboard shortcut). `onAttach` is present only
 * when this person may add to the chat, so both items follow it. Paste is also left out when the
 * browser cannot read the clipboard.
 */
export function useComposerInputActions(onAttach: (() => void) | undefined): DraftComposerAction[] {
  const aui = useAui();
  const toaster = useToasterOptional();
  const paste = async () => {
    try {
      const pasted = await navigator.clipboard.readText();
      const composer = aui.composer();
      composer.setText(appendPasted(composer.getState().text, pasted));
    } catch (error) {
      toaster?.showError(new Error(PASTE_FAILED_MESSAGE, { cause: error }), { title: PASTE_FAILED_TITLE });
    }
  };
  if (onAttach === undefined) return [];
  return [
    { id: 'attach', label: 'Attach files', icon: 'paperclip', onSelect: onAttach },
    ...(canReadClipboard()
      ? [{ id: 'paste', label: 'Paste from clipboard', icon: 'clipboard-paste', onSelect: () => void paste() }]
      : []),
  ];
}
