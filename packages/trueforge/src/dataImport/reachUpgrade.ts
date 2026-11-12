import { NOTICING_ON_BY_DEFAULT } from '../schemas/reach';
import { isRecord } from './lenient';

/**
 * Brings a reach section up to the strict read. Text and phone switches and the background checks depend on what is
 * set up on this install, so they come in as a new person starts, whatever the archive says. An archive from before
 * the background checks had a switch has none, and gets the same value.
 */
export function startReachSwitchesAsNew(raw: unknown): unknown {
  if (!Array.isArray(raw)) {
    return raw;
  }
  const items: unknown[] = raw;
  return items.map(item => {
    if (!isRecord(item)) {
      return item;
    }
    return { ...item, channels: { texts: false, calls: false }, noticing_on: NOTICING_ON_BY_DEFAULT };
  });
}
