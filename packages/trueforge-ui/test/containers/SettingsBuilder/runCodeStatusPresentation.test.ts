// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  formatCheckedAgo,
  formatMegabytes,
  formatSeconds,
  shortImageName,
} from '@/containers/SettingsBuilder/runCodeStatusPresentation.js';

describe('shortImageName', () => {
  it('keeps the name and tag and drops the registry, path and digest', () => {
    expect(shortImageName('ghcr.io/org/amanuensis-sandbox:0.1.0@sha256:' + 'a'.repeat(64))).toBe(
      'amanuensis-sandbox 0.1.0',
    );
  });

  it('copes with a reference that has no tag', () => {
    expect(shortImageName('registry.example:5000/team/sandbox@sha256:' + 'b'.repeat(64))).toBe('sandbox');
  });
});

describe('formatMegabytes and formatSeconds', () => {
  it('uses GB for whole gigabytes and MB otherwise', () => {
    expect(formatMegabytes(2048)).toBe('2 GB');
    expect(formatMegabytes(1024)).toBe('1 GB');
    expect(formatMegabytes(512)).toBe('512 MB');
    expect(formatMegabytes(1536)).toBe('1536 MB');
  });

  it('uses minutes for whole minutes and seconds otherwise', () => {
    expect(formatSeconds(600)).toBe('10 min');
    expect(formatSeconds(90)).toBe('90 s');
  });
});

describe('formatCheckedAgo', () => {
  const at = 1_000_000;
  it('reads just now, minutes, then hours', () => {
    expect(formatCheckedAgo({ checkedAt: at, now: at + 59_000 })).toBe('just now');
    expect(formatCheckedAgo({ checkedAt: at, now: at + 3 * 60_000 })).toBe('3 min ago');
    expect(formatCheckedAgo({ checkedAt: at, now: at + 125 * 60_000 })).toBe('2 h ago');
  });
});
