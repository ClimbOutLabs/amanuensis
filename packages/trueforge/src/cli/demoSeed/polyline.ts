export interface LatLng {
  lat: number;
  lng: number;
}

function encodeSigned(value: number): string {
  let remaining = value < 0 ? ~(value << 1) : value << 1;
  let encoded = '';
  while (remaining >= 0x20) {
    encoded += String.fromCharCode((0x20 | (remaining & 0x1f)) + 63);
    remaining >>= 5;
  }
  return encoded + String.fromCharCode(remaining + 63);
}

/** Precision-5 encoded polyline, the format the map card decodes. */
export function encodePolyline(points: readonly LatLng[]): string {
  let previousLat = 0;
  let previousLng = 0;
  let encoded = '';
  for (const point of points) {
    const lat = Math.round(point.lat * 1e5);
    const lng = Math.round(point.lng * 1e5);
    encoded += encodeSigned(lat - previousLat) + encodeSigned(lng - previousLng);
    previousLat = lat;
    previousLng = lng;
  }
  return encoded;
}
