/** Encoded-polyline helpers shared by the road and public transport route providers. */

/** Longest encoded geometry a route result carries. */
export const MAX_GEOMETRY_CHARS = 8000;

/**
 * Thin an encoded polyline to at most maxChars by dropping points evenly,
 * always keeping both endpoints so the line still draws.
 */
export function thinPolyline(encoded: string, maxChars: number): string {
  if (encoded.length <= maxChars) {
    return encoded;
  }
  // Decode to points, thin, re-encode. Precision 5.
  const points = decodePolyline(encoded);
  if (points.length <= 2) {
    return encoded;
  }
  // Binary search the stride that fits.
  let low = 2;
  let high = points.length;
  let best = encoded;
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) {
    return encoded;
  }
  while (low <= high) {
    const stride = Math.floor((low + high) / 2);
    const thinned: [number, number][] = [first];
    for (let i = stride; i < points.length - 1; i += stride) {
      const point = points[i];
      if (point !== undefined) {
        thinned.push(point);
      }
    }
    thinned.push(last);
    const candidate = encodePolyline(thinned);
    if (candidate.length <= maxChars) {
      best = candidate;
      high = stride - 1;
    } else {
      low = stride + 1;
    }
  }
  return best;
}

/** Decode an encoded polyline (precision 5 unless told otherwise) to [lat, lng] pairs. */
export function decodePolyline(encoded: string, precision = 5): [number, number][] {
  const scale = 10 ** precision;
  const points: [number, number][] = [];
  let lat = 0;
  let lng = 0;
  let index = 0;
  while (index < encoded.length) {
    const latResult = decodePolylineValue(encoded, { index });
    lat += latResult.value;
    index = latResult.nextIndex;
    const lngResult = decodePolylineValue(encoded, { index });
    lng += lngResult.value;
    index = lngResult.nextIndex;
    points.push([lat / scale, lng / scale]);
  }
  return points;
}

function decodePolylineValue(encoded: string, state: { index: number }): { value: number; nextIndex: number } {
  let shift = 0;
  let result = 0;
  let index = state.index;
  let byte: number;
  do {
    byte = encoded.charCodeAt(index) - 63;
    index += 1;
    result |= (byte & 0x1f) << shift;
    shift += 5;
  } while (byte >= 0x20);
  const value = (result & 1) === 1 ? ~(result >> 1) : result >> 1;
  return { value, nextIndex: index };
}

/** Encode [lat, lng] pairs as a precision-5 polyline. */
export function encodePolyline(points: [number, number][]): string {
  let lastLat = 0;
  let lastLng = 0;
  let out = '';
  for (const [lat, lng] of points) {
    const latInt = Math.round(lat * 1e5);
    const lngInt = Math.round(lng * 1e5);
    out += encodePolylineValue(latInt - lastLat);
    out += encodePolylineValue(lngInt - lastLng);
    lastLat = latInt;
    lastLng = lngInt;
  }
  return out;
}

function encodePolylineValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}
