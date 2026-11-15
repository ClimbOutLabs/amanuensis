import type { TurnTimezone } from '../../src/runtime/turnTimezone';

/** A test server with no saved zones: a turn's zone is whatever the browser sent with it. */
export const browserTurnTimezone: TurnTimezone = ({ clientTimezone }) => Promise.resolve(clientTimezone);
