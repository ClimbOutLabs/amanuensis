// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TextsSettings } from '@/deliveries/TextsSettings.js';
import type { TextsApi, TextStatus } from '@/deliveries/types.js';

const CONFIRMED: TextStatus = {
  phone: '+15550100',
  confirmed: true,
  mode: 'private',
  optedOut: false,
  codePending: false,
  pendingPhone: null,
  privatePreview: 'Mannie: a reminder is due. Open the app to see it.',
  words: [],
};

function textsApi(status: TextStatus): TextsApi {
  return {
    status: vi.fn(() => Promise.resolve(status)),
    sendCode: vi.fn(() => Promise.resolve(status)),
    confirm: vi.fn(() => Promise.resolve(status)),
    setMode: vi.fn(() => Promise.resolve(status)),
    addWord: vi.fn(() => Promise.resolve(status)),
    removeWord: vi.fn(() => Promise.resolve(status)),
    remove: vi.fn(() => Promise.resolve()),
  };
}

describe('Settings, Reach me, texts', () => {
  it('says Full carries only a reminder’s own words, and noticed items still name only their kind', async () => {
    render(
      <TextsSettings
        texts={textsApi(CONFIRMED)}
        textsOn={false}
        savedOn={false}
        onTextsOn={() => undefined}
        problem={null}
        tryButton={null}
      />,
    );
    const full = await screen.findByText(/^A reminder’s own words/);
    expect(full.textContent).toBe(
      'A reminder’s own words, cut to fit two texts. Anything your assistant noticed still says only its kind. A reminder with a word Aman does not know, a link, a long number or signs is sent as Private. It can show on a locked screen and is seen by Twilio and the phone company.',
    );
    expect(screen.queryByText(/one-sentence message/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says when STOP replies cannot reach Aman, in the words the server chose for this person', async () => {
    const words = 'STOP replies do not reach Aman yet. Ask the person who runs Aman to check the Twilio settings.';
    render(
      <TextsSettings
        texts={textsApi(CONFIRMED)}
        textsOn={false}
        savedOn={false}
        onTextsOn={() => undefined}
        problem={words}
        tryButton={null}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toBe(words);
  });

  it('lists the words Aman may text, adds one, and takes one off', async () => {
    const texts = textsApi({ ...CONFIRMED, words: ['patel'] });
    render(
      <TextsSettings
        texts={texts}
        textsOn={false}
        savedOn={false}
        onTextsOn={() => undefined}
        problem={null}
        tryButton={null}
      />,
    );
    expect(await screen.findByText('Words Aman may text')).toBeTruthy();
    expect(screen.getByText('patel')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('A name or word'), { target: { value: 'Lopez' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add word' }));
    await waitFor(() => expect(texts.addWord).toHaveBeenCalledWith('Lopez'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove patel' }));
    await waitFor(() => expect(texts.removeWord).toHaveBeenCalledWith('patel'));
  });

  it('shows the server’s reason when a word is refused', async () => {
    const texts = textsApi(CONFIRMED);
    texts.addWord = vi.fn(() => Promise.reject(new Error('A web ending or a number cannot be added.')));
    render(
      <TextsSettings
        texts={texts}
        textsOn={false}
        savedOn={false}
        onTextsOn={() => undefined}
        problem={null}
        tryButton={null}
      />,
    );
    fireEvent.change(await screen.findByLabelText('A name or word'), { target: { value: 'com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add word' }));
    expect((await screen.findByRole('alert')).textContent).toBe('A web ending or a number cannot be added.');
  });
});
