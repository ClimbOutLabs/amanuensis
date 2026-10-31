import { URL } from 'node:url';

// The sidecar's second line of defense: a missed word in the Tier classifier must not become a
// silent purchase. Before a click the host has not already approved, this installs Playwright's own
// request routing on the page and aborts any non-GET request to the page's own site — a form post,
// or a fetch/XHR that sends data — issued while the click is settling. A third-party request (an
// analytics beacon, a payment widget on another domain) is never blocked, only logged for debugging:
// it is not the site the person is on, so it is not what this gate is for.

/** How long after a click to keep watching for a same-site write the click set off asynchronously. */
export const CLICK_GATE_SETTLE_MS = 500;

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Installs the gate on `page` for one site and returns it already active. `blocked` and `allowed`
 * fill in as requests arrive; read them after `remove()` to decide whether the click needs the
 * person's OK after all.
 */
export async function installClickGate({ page, site, log }) {
  const blocked = [];
  const allowed = [];
  const handler = async route => {
    const request = route.request();
    const requestHost = hostOf(request.url());
    if (request.method() === 'GET' || requestHost !== site) {
      allowed.push({ url: request.url(), method: request.method() });
      if (requestHost !== site && request.method() !== 'GET') {
        log?.(`browser gate: allowed third-party ${request.method()} to ${requestHost}`);
      }
      await route.continue();
      return;
    }
    blocked.push({ url: request.url(), method: request.method() });
    log?.(`browser gate: aborted ${request.method()} to ${requestHost}, no approval yet`);
    await route.abort('aborted');
  };
  await page.route('**/*', handler);
  return {
    blocked,
    allowed,
    async remove() {
      await page.unroute('**/*', handler);
    },
  };
}
