import { isServableTileType, parseTileIndex, safeRedirectTarget, validTileCoords } from '../../../src/apis/maps';

describe('validTileCoords', () => {
  it('accepts valid coordinates', () => {
    expect(validTileCoords({ z: 0, x: 0, y: 0 })).toBe(true);
    expect(validTileCoords({ z: 13, x: 4096, y: 4096 })).toBe(true);
    expect(validTileCoords({ z: 18, x: 2 ** 18 - 1, y: 2 ** 18 - 1 })).toBe(true);
  });

  it('rejects out-of-range z', () => {
    expect(validTileCoords({ z: -1, x: 0, y: 0 })).toBe(false);
    expect(validTileCoords({ z: 19, x: 0, y: 0 })).toBe(false);
  });

  it('rejects out-of-range x/y', () => {
    expect(validTileCoords({ z: 1, x: 2, y: 0 })).toBe(false);
    expect(validTileCoords({ z: 1, x: 0, y: 2 })).toBe(false);
    expect(validTileCoords({ z: 0, x: 1, y: 0 })).toBe(false);
    expect(validTileCoords({ z: 2, x: -1, y: 0 })).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(validTileCoords({ z: 13.5, x: 0, y: 0 })).toBe(false);
    expect(validTileCoords({ z: 13, x: 1.2, y: 0 })).toBe(false);
    expect(validTileCoords({ z: Number.NaN, x: 0, y: 0 })).toBe(false);
  });
});

describe('safeRedirectTarget', () => {
  const upstream = 'https://tile.openstreetmap.org/13/4096/4096.png';

  it('allows same-host redirects', () => {
    expect(safeRedirectTarget({ upstreamUrl: upstream, location: '/13/4096/4097.png' })).toBe(
      'https://tile.openstreetmap.org/13/4096/4097.png',
    );
    expect(safeRedirectTarget({ upstreamUrl: upstream, location: 'https://tile.openstreetmap.org/other.png' })).toBe(
      'https://tile.openstreetmap.org/other.png',
    );
  });

  it('rejects redirects to another host', () => {
    expect(safeRedirectTarget({ upstreamUrl: upstream, location: 'https://evil.example/tile.png' })).toBeNull();
    expect(safeRedirectTarget({ upstreamUrl: upstream, location: '//evil.example/tile.png' })).toBeNull();
  });

  it('rejects malformed locations', () => {
    expect(safeRedirectTarget({ upstreamUrl: upstream, location: 'http://[::1' })).toBeNull();
  });
});

describe('parseTileIndex', () => {
  it('accepts plain digits only', () => {
    expect(parseTileIndex('0')).toBe(0);
    expect(parseTileIndex('4096')).toBe(4096);
    for (const raw of ['', '1e1', '0x5', ' 5', '5.0', '-1', '+1', 'Infinity', '123456789']) {
      expect(parseTileIndex(raw)).toBeNaN();
    }
  });
});

describe('isServableTileType', () => {
  it('passes raster images and drops active or non-image types', () => {
    expect(isServableTileType('image/png')).toBe(true);
    expect(isServableTileType('image/jpeg')).toBe(true);
    expect(isServableTileType('image/svg+xml')).toBe(false);
    expect(isServableTileType('text/html')).toBe(false);
    expect(isServableTileType('')).toBe(false);
  });
});
