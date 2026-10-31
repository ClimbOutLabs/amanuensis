import { z } from '@hono/zod-openapi';

/**
 * Wire shapes for the maps server addresses under Settings, Connectors, Maps.
 * All field names are the snake_case setting keys. The saved-values schema is
 * also the validation contract: its messages are the plain-words explanations
 * the card shows next to the field that needs fixing.
 */

/** The six maps servers, in the order the Settings card shows them. */
export const MAPS_SERVER_FIELDS = ['router', 'walking', 'cycling', 'geocoder', 'transit', 'tile'] as const;

export type MapsServerField = (typeof MAPS_SERVER_FIELDS)[number];

/** The name a person would use for each server, for messages. */
export const MAPS_SERVER_LABELS: Record<MapsServerField, string> = {
  router: 'driving route',
  walking: 'walking route',
  cycling: 'cycling route',
  geocoder: 'address search',
  transit: 'public transport',
  tile: 'map pictures',
};

/**
 * The one message explaining why a maps server address cannot be saved, or
 * null when it can. Any http or https address is fine, including one on a home
 * network; the map pictures address must keep its {z}, {x} and {y} placeholders.
 */
export function mapsServerUrlProblem({ field, value }: { field: MapsServerField; value: string }): string | null {
  const label = MAPS_SERVER_LABELS[field];
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return `The ${label} address does not look like a complete web address. Check it and try again.`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `The ${label} address must start with http:// or https://.`;
  }
  if (field === 'tile') {
    for (const placeholder of ['{z}', '{x}', '{y}']) {
      if (!value.includes(placeholder)) {
        return 'The map pictures address needs {z}, {x} and {y} in it, like https://tile.example.org/{z}/{x}/{y}.png.';
      }
    }
  }
  return null;
}

function savedMapsServerUrlSchema(field: MapsServerField) {
  return z
    .string()
    .nullable()
    .optional()
    .superRefine((value, ctx) => {
      if (value === undefined || value === null) {
        return;
      }
      const problem = mapsServerUrlProblem({ field, value });
      if (problem !== null) {
        ctx.addIssue({ code: 'custom', message: problem });
      }
    })
    .describe(
      'A maps server address saved in Settings, or null to clear it back to the default. Omitted keeps the saved address.',
    );
}

/**
 * The maps server addresses saved in Settings, one optional field per server.
 * A field that is absent keeps its saved address; null clears it.
 */
export const MapsServerSettingsSchema = z
  .object({
    maps_router_url: savedMapsServerUrlSchema('router'),
    maps_walking_router_url: savedMapsServerUrlSchema('walking'),
    maps_cycling_router_url: savedMapsServerUrlSchema('cycling'),
    maps_geocoder_url: savedMapsServerUrlSchema('geocoder'),
    maps_transit_url: savedMapsServerUrlSchema('transit'),
    maps_tile_url: savedMapsServerUrlSchema('tile'),
  })
  .openapi('MapsServerSettings');

export type MapsServerSettings = z.infer<typeof MapsServerSettingsSchema>;

/** One maps server field as the Settings card shows it. */
export const MapsServerFieldStateSchema = z
  .object({
    value: z
      .string()
      .nullable()
      .describe(
        'The address in the field: the environment address when the environment sets one, else the address saved in Settings, else null.',
      ),
    default_value: z.string().describe('The built-in default address, shown as the field placeholder.'),
    set_by_environment: z
      .boolean()
      .describe('Whether the server environment sets this address; the field is read-only then and the value wins.'),
  })
  .openapi('MapsServerFieldState');

export type MapsServerFieldState = z.infer<typeof MapsServerFieldStateSchema>;

/** Every maps server field as the Settings card shows it. */
export const MapsSettingsSchema = z
  .object({
    maps_router_url: MapsServerFieldStateSchema,
    maps_walking_router_url: MapsServerFieldStateSchema,
    maps_cycling_router_url: MapsServerFieldStateSchema,
    maps_geocoder_url: MapsServerFieldStateSchema,
    maps_transit_url: MapsServerFieldStateSchema,
    maps_tile_url: MapsServerFieldStateSchema,
  })
  .openapi('MapsSettings');

export type MapsSettings = z.infer<typeof MapsSettingsSchema>;

export const GetMapsSettingsResponseSchema = z
  .object({
    data: MapsSettingsSchema,
  })
  .openapi('GetMapsSettingsResponse');

export const UpdateMapsSettingsRequestSchema = MapsServerSettingsSchema;

/** One service's answer to a connection test. */
export const MapsServerTestResultSchema = z
  .object({
    ok: z.boolean().describe('Whether the server answered the test request.'),
    message: z.string().nullable().describe('Why the test failed, in plain words; null when the server answered.'),
  })
  .openapi('MapsServerTestResult');

export type MapsServerTestResult = z.infer<typeof MapsServerTestResultSchema>;

/** Every service's answer to a connection test, reported separately. */
export const MapsSettingsTestSchema = z
  .object({
    maps_router_url: MapsServerTestResultSchema,
    maps_walking_router_url: MapsServerTestResultSchema,
    maps_cycling_router_url: MapsServerTestResultSchema,
    maps_geocoder_url: MapsServerTestResultSchema,
    maps_transit_url: MapsServerTestResultSchema,
    maps_tile_url: MapsServerTestResultSchema,
  })
  .openapi('MapsSettingsTest');

export type MapsSettingsTest = z.infer<typeof MapsSettingsTestSchema>;

export const TestMapsSettingsResponseSchema = z
  .object({
    data: MapsSettingsTestSchema,
  })
  .openapi('TestMapsSettingsResponse');
