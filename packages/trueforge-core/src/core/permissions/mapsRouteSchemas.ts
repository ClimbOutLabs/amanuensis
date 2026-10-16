/**
 * Canonical owner of the render_route travel modes and result wire shape. A leaf module so the
 * server tool and the map card parse the same contract.
 */
import { z } from 'zod';

export const MAPS_TRAVEL_MODES = ['walking', 'cycling', 'driving', 'transit'] as const;
export const MapsTravelModeSchema = z.enum(MAPS_TRAVEL_MODES);
export type MapsTravelMode = z.infer<typeof MapsTravelModeSchema>;

/** Mode used when a call or a stored result names none. */
export const DEFAULT_MAPS_TRAVEL_MODE: MapsTravelMode = 'driving';

const MapsRouteEndpointSchema = z.object({
  resolved_name: z.string(),
  lat: z.number(),
  lng: z.number(),
});

export const MapsTransitVehicleSchema = z.enum(['tram', 'bus', 'metro', 'train', 'ferry', 'other']);
export type MapsTransitVehicle = z.infer<typeof MapsTransitVehicleSchema>;

/** Clock times are local 24-hour `HH:MM` at the stop. */
export const MapsTransitStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('walk'),
    duration_min: z.number(),
    to_name: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('ride'),
    vehicle: MapsTransitVehicleSchema,
    line_name: z.string(),
    headsign: z.string().nullable(),
    from_name: z.string(),
    to_name: z.string(),
    departs: z.string(),
    arrives: z.string(),
    stops_count: z.number().int().nonnegative(),
  }),
]);
export type MapsTransitStep = z.infer<typeof MapsTransitStepSchema>;

const roadFields = {
  status: z.literal('ok'),
  from: MapsRouteEndpointSchema,
  to: MapsRouteEndpointSchema,
  distance_km: z.number(),
  duration_min: z.number(),
  route_geometry: z.string(),
  attribution: z.string(),
};

export const MapsRouteResultSchema = z.discriminatedUnion('mode', [
  z.object({ ...roadFields, mode: z.literal('walking') }),
  z.object({ ...roadFields, mode: z.literal('cycling') }),
  z.object({ ...roadFields, mode: z.literal('driving'), traffic: z.boolean().optional() }),
  z.object({
    ...roadFields,
    mode: z.literal('transit'),
    departs: z.string(),
    arrives: z.string(),
    transfers: z.number().int().nonnegative(),
    steps: z.array(MapsTransitStepSchema),
  }),
]);
export type MapsRouteResult = z.infer<typeof MapsRouteResultSchema>;
