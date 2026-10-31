import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { problemText, SETUP_BROWSER_PROBLEM, SETUP_OPENING_LINE, setupUrlLine } from '../messages.ts';
import { createSetupServer, SetupSession, type SetupDeps, type SetupHandle } from './server.ts';

export type { SetupDeps, SetupHandle } from './server.ts';

// `aman setup`: the guided install. It decides what state this computer
// is in (a run to attach to, an install already in place, a lock held
// by someone else, or a fresh start), serves the wizard page on this
// computer only, behind a one-time token in its address, and opens it
// in the person's browser unless --no-browser asks for the address
// printed instead. The address is printed whenever the browser does not
// open, so it is never lost.
export async function runSetup(deps: SetupDeps, options: { noBrowser: boolean }): Promise<SetupHandle> {
  const session = new SetupSession(deps);
  const mode = await session.decideMode();
  const token = randomBytes(24).toString('base64url');
  const { server, closed } = createSetupServer(session, token);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the setup page could not be given an address on this computer');
  }
  const addressInfo: AddressInfo = address;
  const url = `http://127.0.0.1:${String(addressInfo.port)}/?t=${token}`;
  const handle: SetupHandle = {
    url,
    mode,
    closed,
    close: () => {
      try {
        server.close();
      } catch {
        // Already closed: closing again changes nothing.
      }
    },
  };
  if (options.noBrowser) {
    deps.print(setupUrlLine(url));
    return handle;
  }
  deps.print(SETUP_OPENING_LINE);
  const opened = await deps.openBrowser(url).catch(() => false);
  if (!opened) {
    deps.print(problemText(SETUP_BROWSER_PROBLEM));
    deps.print(setupUrlLine(url));
  }
  return handle;
}
