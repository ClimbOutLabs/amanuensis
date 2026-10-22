import type { MapRefusedPlace } from './MapCard.js';

/** Each place the page check left out, with its reason. Shown only behind a Details disclosure. */
export function RefusedPlaceList({ refused }: { refused: MapRefusedPlace[] }) {
  return (
    <ul className="maps-card-refused">
      {refused.map(place => (
        <li key={place.name}>
          <span className="maps-card-refused-name">{place.name}</span>: {place.reason}
        </li>
      ))}
    </ul>
  );
}
