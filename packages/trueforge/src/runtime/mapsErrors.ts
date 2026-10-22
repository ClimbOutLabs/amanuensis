/** Maps tool failures: the error codes of the tool result body and the exception that carries one. */
import type { MapsTravelMode } from '@truefoundry/trueforge-core/core';

export type MapsErrorCode =
  'not_found' | 'no_route' | 'service_unavailable' | 'rate_limited' | 'invalid_time' | 'not_grounded';

export interface MapsErrorBody {
  status: 'error';
  code: MapsErrorCode;
  field?: string | undefined;
  mode?: MapsTravelMode | undefined;
  /** Another mode worth offering when this one found nothing. */
  try_instead?: MapsTravelMode | undefined;
  service?: 'geocoder' | 'router' | undefined;
  /** Places that were refused and why, so the model can fix one detail and the card can name them. */
  refused?: { name: string; reason: string }[] | undefined;
  /** Set once a place was refused twice in this turn: tells the model to stop using the map. */
  stop?: string | undefined;
}

/** Upstream failure with a maps error code for the tool result body. */
export class MapsUpstreamError extends Error {
  readonly code: MapsErrorCode;
  readonly service: 'geocoder' | 'router' | undefined;

  constructor(code: MapsErrorCode, service?: 'geocoder' | 'router', cause?: unknown) {
    super(
      `Maps upstream failure: ${code}${service ? ` (${service})` : ''}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'MapsUpstreamError';
    this.code = code;
    this.service = service;
  }
}
