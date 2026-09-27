// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { readToolOutputScreenStatus } from '@/containers/SettingsBuilder/memoryScreenCapability.js';

describe('readToolOutputScreenStatus', () => {
  it('reads configured and reason from the normalized capability', () => {
    expect(
      readToolOutputScreenStatus({
        toolOutputScreen: { enabled: false, configured: false, reason: 'No screening service configured' },
      }),
    ).toEqual({ enabled: false, configured: false, reason: 'No screening service configured' });
  });

  it('reads the snake_case wire shape', () => {
    expect(
      readToolOutputScreenStatus({
        tool_output_screen: { enabled: true, configured: true, threshold: 0.5, timeout_ms: 2_250 },
      }),
    ).toEqual({ enabled: true, configured: true, threshold: 0.5, timeoutMs: 2_250 });
  });

  it('defaults configured to true when the server predates the field', () => {
    expect(readToolOutputScreenStatus({ toolOutputScreen: { enabled: true } })).toEqual({
      enabled: true,
      configured: true,
    });
  });

  it('returns null when the capability is missing or malformed', () => {
    expect(readToolOutputScreenStatus(null)).toBeNull();
    expect(readToolOutputScreenStatus({})).toBeNull();
    expect(readToolOutputScreenStatus({ toolOutputScreen: { enabled: 'yes' } })).toBeNull();
  });
});
