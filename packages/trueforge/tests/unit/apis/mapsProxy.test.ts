import { safeRedirectTarget, validTileCoords } from '../../../src/apis/maps';

describe('validTileCoords', () => {
  it('accepts valid coordinates', () => {
    expect(validTileCoords(0, 0, 0)).toBe(true);
    expect(validTileCoords(13, 4096, 4096)).toBe(true);
    expect(validTileCoords(18, 2 ** 18 - 1, 2 ** 18 - 1)).toBe(true);
  });

  it('rejects out-of-range z', () => {
    expect(validTileCoords(-1, 0, 0)).toBe(false);
    expect(validTileCoords(19, 0, 0)).toBe(false);
  });

  it('rejects out-of-range x/y', () => {
    expect(validTileCoords(1, 2, 0)).toBe(false);
    expect(validTileCoords(1, 0, 2)).toBe(false);
    expect(validTileCoords(0, 1, 0)).toBe(false);
    expect(validTileCoords(2, -1, 0)).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(validTileCoords(13.5, 0, 0)).toBe(false);
    expect(validTileCoords(13, 1.2, 0)).toBe(false);
    expect(validTileCoords(Number.NaN, 0, 0)).toBe(false);
  });
});

describe('safeRedirectTarget', () => {
  const upstream = 'https://tile.openstreetmap.org/13/4096/4096.png';

  it('allows same-host redirects', () => {
    expect(safeRedirectTarget(upstream, '/13/4096/4097.png')).toBe('https://tile.openstreetmap.org/13/4096/4097.png');
    expect(safeRedirectTarget(upstream, 'https://tile.openstreetmap.org/other.png')).toBe(
      'https://tile.openstreetmap.org/other.png',
    );
  });

  it('rejects redirects to another host', () => {
    expect(safeRedirectTarget(upstream, 'https://evil.example/tile.png')).toBeNull();
    expect(safeRedirectTarget(upstream, '//evil.example/tile.png')).toBeNull();
  });

  it('rejects malformed locations', () => {
    expect(safeRedirectTarget(upstream, 'http://[::1')).toBeNull();
  });
});
