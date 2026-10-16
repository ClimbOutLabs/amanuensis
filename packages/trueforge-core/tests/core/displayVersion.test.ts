import { APP_DISPLAY_VERSION, formatDisplayVersion, formatDisplayVersionFull } from '../../src/core/displayVersion';

describe('formatDisplayVersion', () => {
  it('pairs the display version with a shortened commit stamp', () => {
    expect(formatDisplayVersion('4f2a91c8d3b7e6510a2c9f4b8d1e7a3c5b6d8e90')).toBe(`${APP_DISPLAY_VERSION} · 4f2a91c`);
  });

  it('keeps a tag-shaped reference whole', () => {
    expect(formatDisplayVersion('v1.0.0-rc1')).toBe(`${APP_DISPLAY_VERSION} · v1.0.0-rc1`);
  });

  it('reads as a dev build without a stamp', () => {
    expect(formatDisplayVersion(undefined)).toBe(`${APP_DISPLAY_VERSION} · dev`);
    expect(formatDisplayVersion('   ')).toBe(`${APP_DISPLAY_VERSION} · dev`);
  });
});

describe('formatDisplayVersionFull', () => {
  it('keeps the full reference', () => {
    expect(formatDisplayVersionFull('4f2a91c8d3b7e6510a2c9f4b8d1e7a3c5b6d8e90')).toBe(
      `${APP_DISPLAY_VERSION} · 4f2a91c8d3b7e6510a2c9f4b8d1e7a3c5b6d8e90`,
    );
  });

  it('reads as a dev build without a stamp', () => {
    expect(formatDisplayVersionFull(undefined)).toBe(`${APP_DISPLAY_VERSION} · dev`);
  });
});
