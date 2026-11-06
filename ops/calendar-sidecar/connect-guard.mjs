// Loaded into the CalDAV tool server with --import. The supervisor checks the calendar address before it
// starts the tool server, but the tool server looks the name up again for every connection, so a name that
// later points at a forbidden address would slip past that one check. This applies the same address rules
// to every lookup the tool server makes. An address written as a number needs no lookup; the supervisor
// checks that one before every start, and the tool server talks to no other host.
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';

import { addressAllowed, ownNetworks } from './account.mjs';

const lookup = dns.lookup;
const own = ownNetworks();

function refused(host) {
  return Object.assign(new Error(`The calendar address ${host} is not one this service may use.`), {
    code: 'EAI_FAIL',
    hostname: host,
  });
}

dns.lookup = function guardedLookup(host, options, callback) {
  const done = typeof options === 'function' ? options : callback;
  const settings = typeof options === 'function' ? {} : typeof options === 'number' ? { family: options } : options;
  // Every address is asked for, so one forbidden answer refuses the name, as the supervisor's check does.
  lookup.call(dns, host, { ...settings, all: true }, (error, entries) => {
    if (error !== null) {
      done(error);
      return;
    }
    if (entries.length === 0 || !entries.every(entry => addressAllowed(entry.address, own))) {
      done(refused(host));
      return;
    }
    if (settings?.all === true) {
      done(null, entries);
    } else {
      done(null, entries[0].address, entries[0].family);
    }
  });
};
syncBuiltinESMExports();
