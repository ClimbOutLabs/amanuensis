// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
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
};

function textsApi(status: TextStatus): TextsApi {
  return {
    status: vi.fn(() => Promise.resolve(status)),
    sendCode: vi.fn(() => Promise.resolve(status)),
    confirm: vi.fn(() => Promise.resolve(status)),
    setMode: vi.fn(() => Promise.resolve(status)),
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
        tryButton={null}
      />,
    );
    const full = await screen.findByText(/^A reminder’s own words/);
    expect(full.textContent).toBe(
      'A reminder’s own words, cut to fit two texts. Anything your assistant noticed still says only its kind. It can show on a locked screen and is seen by Twilio and the phone company.',
    );
    expect(screen.queryByText(/one-sentence message/)).toBeNull();
  });
});
