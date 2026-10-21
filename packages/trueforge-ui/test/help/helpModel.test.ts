import { describe, expect, it } from 'vitest';

import {
  buildIrisHelpMessage,
  formatLastFullCheck,
  sortHelpItems,
  type HelpHealthCheck,
  type HelpHealthItem,
} from '@/help/helpModel.js';
import { describeHelpScreen } from '@/help/helpScreen.js';

const CHECK: HelpHealthCheck = {
  checked_at: '2026-10-21T09:00:00Z',
  model_ready: true,
  items: [
    { id: 'model', name: 'Your model', status: 'pass', message: 'The model answered.', next_step: null },
    {
      id: 'connectors',
      name: 'Connectors',
      status: 'fail',
      message: 'These connectors did not answer: notion.',
      next_step: 'Open Settings, Connectors and check each one.',
    },
  ],
  host_report: { state: 'ok', checked_at: '2026-10-20T08:30:00Z', message: null, next_step: null },
};

describe('buildIrisHelpMessage', () => {
  it('carries the results, the screen and the last error, and names Iris so she speaks first', () => {
    const message = buildIrisHelpMessage({
      check: CHECK,
      screen: 'Settings, Connectors',
      lastError: 'Request failed (500): The connector did not answer.',
    });

    expect(message.startsWith('Iris, ')).toBe(true);
    expect(message).toContain('Where are you stuck?');
    expect(message).toContain('- Your model: ok. The model answered.');
    expect(message).toContain('- Connectors: failed. These connectors did not answer: notion.');
    expect(message).toContain('You were on: Settings, Connectors.');
    expect(message).toContain('Last error: Request failed (500): The connector did not answer.');
  });

  it('says none when there was no last error', () => {
    const message = buildIrisHelpMessage({ check: CHECK, screen: 'Chat', lastError: null });

    expect(message).toContain('Last error: none.');
  });

  it('carries nothing from chat, mail, calendar or files: only the check, the screen and the last error', () => {
    const message = buildIrisHelpMessage({ check: CHECK, screen: 'Chat', lastError: null });
    const lines = message.split('\n');

    // Every line is either the greeting, the results header, a result line, or the screen and error lines.
    for (const line of lines) {
      const allowed =
        line.startsWith('Iris, ') ||
        line === 'Health check results:' ||
        line.startsWith('- ') ||
        line.startsWith('You were on: ') ||
        line.startsWith('Last error: ');
      expect(allowed, `unexpected line: ${line}`).toBe(true);
    }
    expect(message).not.toMatch(/subject|inbox|from:|attachment|invite|meeting|file/i);
  });

  it('keeps the host report line when the report needs attention', () => {
    const message = buildIrisHelpMessage({
      check: {
        ...CHECK,
        host_report: {
          state: 'missing',
          checked_at: null,
          message: 'No full check has been run yet. Run aman doctor on your computer.',
          next_step: null,
        },
      },
      screen: 'Chat',
      lastError: null,
    });

    expect(message).toContain('- Last full check: No full check has been run yet. Run aman doctor on your computer.');
  });
});

describe('sortHelpItems', () => {
  it('keeps the model first even when another line is failing', () => {
    const items: HelpHealthItem[] = [
      { id: 'connectors', name: 'Connectors', status: 'fail', message: 'x', next_step: null },
      { id: 'model', name: 'Your model', status: 'fail', message: 'No model is connected.', next_step: null },
      { id: 'sandbox', name: 'Sandbox', status: 'warn', message: 'y', next_step: null },
    ];

    expect(sortHelpItems(items).map(item => item.id)).toEqual(['model', 'connectors', 'sandbox']);
  });
});

describe('formatLastFullCheck', () => {
  it('shows the time from the UTC timestamp in local form, not the raw ISO text', () => {
    const text = formatLastFullCheck('2026-10-20T08:30:00Z', 'en-US');

    expect(text).not.toContain('T08:30');
    expect(text).toMatch(/2026/);
  });
});

describe('describeHelpScreen', () => {
  const closed = {
    settingsOpen: false,
    settingsSection: 'models' as const,
    libraryOpen: false,
    sessionsOpen: false,
    schedulesOpen: false,
    spacesOpen: false,
  };

  it('names the settings section the person was on', () => {
    expect(describeHelpScreen({ ...closed, settingsOpen: true, settingsSection: 'connectors' })).toBe(
      'Settings, Connectors',
    );
  });

  it('names the other main screens and falls back to Chat', () => {
    expect(describeHelpScreen({ ...closed, schedulesOpen: true })).toBe('Schedules');
    expect(describeHelpScreen({ ...closed, libraryOpen: true })).toBe('Agent library');
    expect(describeHelpScreen(closed)).toBe('Chat');
    expect(describeHelpScreen(null)).toBe('Chat');
  });
});
