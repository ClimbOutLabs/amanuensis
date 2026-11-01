/**
 * Public transport planning for `render_route` with mode `transit`, against a MOTIS-compatible
 * planner. The planner returns whole itineraries; this module keeps the one that best fits the
 * requested time and reduces it to the plain steps the map card shows.
 */
import { resolveLocalTime, type MapsTransitStep, type MapsTransitVehicle } from '@truefoundry/trueforge-core/core';
import { z } from 'zod';
import { MapsUpstreamError } from './mapsErrors';
import { decodePolyline, encodePolyline, MAX_GEOMETRY_CHARS, thinPolyline } from './mapsPolyline';
import { readCappedJson } from './mapsUpstream';

export interface MapsTransitRequest {
  from_lat: number;
  from_lng: number;
  to_lat: number;
  to_lng: number;
  /** ISO time with a UTC offset, or null for "now". */
  time: string | null;
  /** True when `time` is the latest arrival rather than the earliest departure. */
  arrive_by: boolean;
  /** Valid IANA zone used to print clock times when the planner does not name a usable stop zone. */
  fallback_timezone: string;
}

export interface MapsTransitPlan {
  distance_km: number;
  duration_min: number;
  /** Encoded polyline, precision 5, at most 8,000 chars. */
  geometry: string;
  departs: string;
  arrives: string;
  transfers: number;
  steps: MapsTransitStep[];
}

export interface MapsTransitProvider {
  plan(input: MapsTransitRequest): Promise<MapsTransitPlan>;
}

const placeSchema = z.object({
  name: z.string().optional(),
  lat: z.number(),
  lon: z.number(),
  tz: z.string().optional(),
});

const legSchema = z.object({
  mode: z.string(),
  from: placeSchema,
  to: placeSchema,
  startTime: z.string(),
  endTime: z.string(),
  routeShortName: z.string().optional(),
  headsign: z.string().optional(),
  intermediateStops: z.array(z.unknown()).optional(),
  legGeometry: z.object({ points: z.string(), precision: z.number().int().optional() }).optional(),
});

const planSchema = z.object({
  itineraries: z.array(
    z.object({
      startTime: z.string(),
      endTime: z.string(),
      transfers: z.number().int().optional(),
      legs: z.array(legSchema),
    }),
  ),
});

type Leg = z.infer<typeof legSchema>;

/** MOTIS encodes leg geometry at precision 6 unless the leg says otherwise. */
const DEFAULT_LEG_PRECISION = 6;
/** A decoded geometry that starts farther than this (degrees) from its leg is treated as garbled. */
const GEOMETRY_START_TOLERANCE_DEGREES = 0.01;

function vehicleFor(mode: string): MapsTransitVehicle {
  switch (mode.toUpperCase()) {
    case 'TRAM':
      return 'tram';
    case 'BUS':
    case 'COACH':
      return 'bus';
    case 'SUBWAY':
    case 'METRO':
      return 'metro';
    case 'RAIL':
    case 'HIGHSPEED_RAIL':
    case 'LONG_DISTANCE':
    case 'NIGHT_RAIL':
    case 'REGIONAL_FAST_RAIL':
    case 'REGIONAL_RAIL':
    case 'SUBURBAN':
      return 'train';
    case 'FERRY':
      return 'ferry';
    default:
      return 'other';
  }
}

/** Local 24-hour `HH:MM` for an instant in a zone; falls back to the already-valid `fallback` zone. */
function clockTime({
  iso,
  timezone,
  fallback,
}: {
  iso: string;
  timezone: string | undefined;
  fallback: string;
}): string {
  const date = new Date(iso);
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
      date,
    );
  try {
    return format(timezone ?? fallback);
  } catch {
    return format(fallback);
  }
}

function minutesBetween({ start, end }: { start: string; end: string }): number {
  return Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60_000));
}

function legPoints(leg: Leg): [number, number][] {
  const straight: [number, number][] = [
    [leg.from.lat, leg.from.lon],
    [leg.to.lat, leg.to.lon],
  ];
  if (leg.legGeometry === undefined) {
    return straight;
  }
  try {
    const points = decodePolyline(leg.legGeometry.points, leg.legGeometry.precision ?? DEFAULT_LEG_PRECISION);
    const first = points[0];
    if (
      first === undefined ||
      Math.abs(first[0] - leg.from.lat) > GEOMETRY_START_TOLERANCE_DEGREES ||
      Math.abs(first[1] - leg.from.lon) > GEOMETRY_START_TOLERANCE_DEGREES
    ) {
      return straight;
    }
    return points;
  } catch {
    return straight;
  }
}

function kilometres(points: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) {
      continue;
    }
    const dLat = ((b[0] - a[0]) * Math.PI) / 180;
    const dLng = ((b[1] - a[1]) * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    total += 2 * 6371 * Math.asin(Math.sqrt(h));
  }
  return total;
}

function stepsFor({ legs, fallback }: { legs: Leg[]; fallback: string }): MapsTransitStep[] {
  const steps: MapsTransitStep[] = [];
  legs.forEach((leg, index) => {
    const isLast = index === legs.length - 1;
    if (leg.mode.toUpperCase() === 'WALK') {
      const duration_min = Math.max(1, minutesBetween({ start: leg.startTime, end: leg.endTime }));
      const previous = steps[steps.length - 1];
      if (previous?.kind === 'walk') {
        steps[steps.length - 1] = {
          kind: 'walk',
          duration_min: previous.duration_min + duration_min,
          to_name: isLast ? null : (leg.to.name ?? null),
        };
        return;
      }
      steps.push({ kind: 'walk', duration_min, to_name: isLast ? null : (leg.to.name ?? null) });
      return;
    }
    steps.push({
      kind: 'ride',
      vehicle: vehicleFor(leg.mode),
      line_name: leg.routeShortName ?? leg.mode.toLowerCase(),
      headsign: leg.headsign ?? null,
      from_name: leg.from.name ?? '',
      to_name: leg.to.name ?? '',
      departs: clockTime({ iso: leg.startTime, timezone: leg.from.tz, fallback }),
      arrives: clockTime({ iso: leg.endTime, timezone: leg.to.tz, fallback }),
      stops_count: leg.intermediateStops === undefined ? null : leg.intermediateStops.length + 1,
    });
  });
  return steps;
}

type Itinerary = z.infer<typeof planSchema>['itineraries'][number];

/**
 * Arriving by a time: the latest arrival that makes it, else the least late one. Otherwise the
 * earliest arrival. Planner order is not relied on.
 */
function chooseItinerary({
  itineraries,
  arrive_by,
}: {
  itineraries: Itinerary[];
  arrive_by: string | null;
}): Itinerary | undefined {
  const highest = (from: Itinerary[], score: (candidate: Itinerary) => number) =>
    from.reduce<Itinerary | undefined>(
      (best, candidate) => (best === undefined || score(candidate) > score(best) ? candidate : best),
      undefined,
    );
  const earliestArrival = highest(itineraries, candidate => -Date.parse(candidate.endTime));
  if (arrive_by === null) {
    return earliestArrival;
  }
  const deadline = Date.parse(arrive_by);
  const inTime = itineraries.filter(candidate => Date.parse(candidate.endTime) <= deadline);
  return highest(inTime, candidate => Date.parse(candidate.endTime)) ?? earliestArrival;
}

/** MOTIS-compatible planner, e.g. the Transitous public instance. */
export class MotisTransitProvider implements MapsTransitProvider {
  constructor(
    private readonly base_url: string,
    private readonly fetch_limited: (url: string) => Promise<Response>,
  ) {}

  async plan(input: MapsTransitRequest): Promise<MapsTransitPlan> {
    const query = new URLSearchParams({
      fromPlace: `${String(input.from_lat)},${String(input.from_lng)}`,
      toPlace: `${String(input.to_lat)},${String(input.to_lng)}`,
    });
    if (input.time !== null) {
      query.set('time', input.time);
      query.set('arriveBy', String(input.arrive_by));
      if (input.arrive_by) {
        // Best journeys arriving by the time, rather than a timetable of departures around it.
        query.set('timetableView', 'false');
      }
    }
    let response: Response;
    try {
      response = await this.fetch_limited(`${this.base_url}/plan?${query.toString()}`);
    } catch (error) {
      throw new MapsUpstreamError('service_unavailable', 'router', error);
    }
    if (response.status === 429) {
      throw new MapsUpstreamError('rate_limited', 'router');
    }
    if (!response.ok) {
      throw new MapsUpstreamError('service_unavailable', 'router');
    }
    const body = await readCappedJson(response);
    if (body === null) {
      throw new MapsUpstreamError('service_unavailable', 'router');
    }
    const parsed = planSchema.safeParse(body.value);
    if (!parsed.success) {
      throw new MapsUpstreamError('service_unavailable', 'router', parsed.error);
    }
    const itinerary = chooseItinerary({
      itineraries: parsed.data.itineraries,
      arrive_by: input.arrive_by ? input.time : null,
    });
    if (itinerary === undefined || itinerary.legs.length === 0) {
      throw new MapsUpstreamError('no_route');
    }
    const points = itinerary.legs.flatMap(leg => legPoints(leg));
    const firstLeg = itinerary.legs[0];
    const lastLeg = itinerary.legs[itinerary.legs.length - 1];
    const fallback = input.fallback_timezone;
    const steps = stepsFor({ legs: itinerary.legs, fallback });
    const rides = steps.filter(step => step.kind === 'ride').length;
    return {
      distance_km: Math.round(kilometres(points) * 10) / 10,
      duration_min: minutesBetween({ start: itinerary.startTime, end: itinerary.endTime }),
      geometry: thinPolyline(encodePolyline(points), MAX_GEOMETRY_CHARS),
      departs: clockTime({ iso: itinerary.startTime, timezone: firstLeg?.from.tz, fallback }),
      arrives: clockTime({ iso: itinerary.endTime, timezone: lastLeg?.to.tz, fallback }),
      transfers: itinerary.transfers ?? Math.max(0, rides - 1),
      steps,
    };
  }
}

const LOCAL_TIME_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const OFFSET_TIME_SHAPE = /(Z|[+-]\d{2}:\d{2})$/;

/**
 * A requested time as an ISO string with a UTC offset, reading a bare local time in `timezone`.
 * Null when the text is not a date and time.
 */
export function resolveTransitTime({ local, timezone }: { local: string; timezone: string }): string | null {
  const text = local.trim();
  if (OFFSET_TIME_SHAPE.test(text)) {
    return Number.isNaN(Date.parse(text)) ? null : text;
  }
  if (!LOCAL_TIME_SHAPE.test(text)) {
    return null;
  }
  const withSeconds = text.length === 16 ? `${text}:00` : text;
  const wallAsUtc = Date.parse(`${withSeconds}Z`);
  if (Number.isNaN(wallAsUtc)) {
    return null;
  }
  // The offset can differ either side of a clock change, so settle it from the instant it implies.
  const guess = resolveLocalTime(new Date(wallAsUtc), timezone).utcOffset;
  const instant = wallAsUtc - offsetMs(guess);
  const offset = resolveLocalTime(new Date(instant), timezone).utcOffset;
  return `${withSeconds}${offset}`;
}

function offsetMs(offset: string): number {
  const sign = offset.startsWith('-') ? -1 : 1;
  const [hours = '0', minutes = '0'] = offset.slice(1).split(':');
  return sign * (Number(hours) * 60 + Number(minutes)) * 60_000;
}
