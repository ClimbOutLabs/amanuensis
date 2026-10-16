import type {
  MapsTransitStep,
  MapsTransitVehicle,
} from '@truefoundry/trueforge-core/core/permissions/mapsRouteSchemas';

const VEHICLE_WORDS: Record<MapsTransitVehicle, string> = {
  tram: 'Tram',
  bus: 'Bus',
  metro: 'Metro',
  train: 'Train',
  ferry: 'Ferry',
  other: 'Line',
};

/** One transit step in plain words, e.g. "Tram 28E toward Campo Ourique, 6 stops, leaves 09:02". */
export function describeTransitStep(step: MapsTransitStep): string {
  if (step.kind === 'walk') {
    return step.to_name === null
      ? `Walk ${String(step.duration_min)} min`
      : `Walk ${String(step.duration_min)} min to ${step.to_name}`;
  }
  const toward = step.headsign === null ? '' : ` toward ${step.headsign}`;
  const stops = step.stops_count === 1 ? '1 stop' : `${String(step.stops_count)} stops`;
  return `${VEHICLE_WORDS[step.vehicle]} ${step.line_name}${toward}, ${stops}, leaves ${step.departs}`;
}

/** Whole minutes, or hours and minutes from an hour up, for the card subtitle. */
export function describeDuration(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole < 60) {
    return `${String(whole)} min`;
  }
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}
