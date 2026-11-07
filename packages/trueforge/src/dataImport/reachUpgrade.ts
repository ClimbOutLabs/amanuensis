import { isRecord } from './lenient';

/**
 * Brings a reach section up to the strict read. Text and phone switches are set up per install, so they come in off
 * whatever the archive says; the person turns them on where they are set up.
 */
export function switchPhoneChannelsOff(raw: unknown): unknown {
  if (!Array.isArray(raw)) {
    return raw;
  }
  const items: unknown[] = raw;
  return items.map(item => {
    if (!isRecord(item)) {
      return item;
    }
    return { ...item, channels: { texts: false, calls: false } };
  });
}
