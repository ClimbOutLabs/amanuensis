import { decodePolyline, encodePolyline, thinPolyline } from '../../../src/runtime/mapsPolyline';

describe('polyline helpers', () => {
  it('round-trips through encode and decode', () => {
    const points: Array<[number, number]> = [
      [48.858844, 2.294481],
      [48.86, 2.296],
      [48.862, 2.3],
    ];
    const encoded = encodePolyline(points);
    const decoded = decodePolyline(encoded);
    expect(decoded).toHaveLength(3);
    for (const [index, [lat, lng]] of decoded.entries()) {
      expect(lat).toBeCloseTo(points[index]?.[0] ?? 0, 4);
      expect(lng).toBeCloseTo(points[index]?.[1] ?? 0, 4);
    }
  });

  it('thinPolyline keeps both endpoints and fits the bound', () => {
    const points: Array<[number, number]> = [];
    for (let i = 0; i < 500; i += 1) {
      points.push([48.8 + i * 0.001, 2.29 + i * 0.001]);
    }
    const encoded = encodePolyline(points);
    const thinned = thinPolyline(encoded, 200);
    expect(thinned.length).toBeLessThanOrEqual(200);
    const decoded = decodePolyline(thinned);
    expect(decoded[0]).toEqual([expect.closeTo(48.8, 4), expect.closeTo(2.29, 4)]);
    const last = decoded[decoded.length - 1];
    expect(last?.[0]).toBeCloseTo(48.8 + 499 * 0.001, 4);
  });

  it('thinPolyline leaves short geometries alone', () => {
    const encoded = encodePolyline([
      [48.85, 2.29],
      [48.86, 2.3],
    ]);
    expect(thinPolyline(encoded, 8000)).toBe(encoded);
  });
});
