/**
 * The Go mirror serves only the documented module proxy and checksum database addresses, for modules
 * from a list of known code hosts. The path is decoded once, checked in that decoded form, and the
 * decoded form is what goes upstream, so what is checked is exactly what is fetched.
 */

/** The code hosts and well-known vanity hosts the Go mirror serves modules from, by first path element. */
export const DEFAULT_GO_MODULE_HOSTS: readonly string[] = [
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'git.sr.ht',
  'code.gitea.io',
  'golang.org',
  'google.golang.org',
  'go.googlesource.com',
  'cloud.google.com',
  'gopkg.in',
  'go.uber.org',
  'k8s.io',
  'sigs.k8s.io',
  'istio.io',
  'knative.dev',
  'helm.sh',
  'oras.land',
  'go.opentelemetry.io',
  'go.opencensus.io',
  'go.etcd.io',
  'go.mongodb.org',
  'go.starlark.net',
  'go.mozilla.org',
  'go.temporal.io',
  'gocloud.dev',
  'golang.zx2c4.com',
  'gonum.org',
  'gioui.org',
  'fyne.io',
  'filippo.io',
  'rsc.io',
  'honnef.co',
  'gorm.io',
  'entgo.io',
  'connectrpc.com',
  'cuelang.org',
  'gotest.tools',
  'modernc.org',
  'lukechampine.com',
  'mvdan.cc',
  'nhooyr.io',
  'storj.io',
  'dario.cat',
  'go.yaml.in',
  'cel.dev',
];

/** The only checksum database the mirror reaches. */
const GO_SUMDB_NAME = 'sum.golang.org';

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** Everything a decoded Go path may contain: the lower-case escaped form plus the separators and markers. */
const DECODED_PATH = /^\/[a-z0-9._~+!@/-]*$/;
/** A module path element or a version in module proxy escaping: `!` and a lower-case letter stand for an upper-case one. */
const ESCAPED_NAME = /^(?:[a-z0-9]|![a-z])(?:[a-z0-9._~+-]|![a-z])*$/;
const TILE_PATH = /^\/tile\/[0-9]+\/(?:[0-9]+|data)\/(?:x[0-9]{3}\/)*[0-9]{3}(?:\.p\/[0-9]+)?$/;
const PROXY_FILE = /^(.+)\.(?:info|mod|zip)$/;

/** The last label starts with a letter, so `1.2.3.4`, `0x7f.0.0.1` and other number forms are never names. */
const TOP_LABEL = /^[a-z][a-z0-9-]*$/;

/** Whether a name is a lower-case DNS name with at least one dot: no IP address, port, path, wildcard or upper case. */
export function isGoModuleHostName(name: string): boolean {
  return HOST_NAME.test(name) && TOP_LABEL.test(name.slice(name.lastIndexOf('.') + 1));
}

export type GoMirrorPathCheck =
  | { allowed: true; path: string }
  | { allowed: false; reason: 'shape' }
  | { allowed: false; reason: 'host'; host: string };

const SHAPE: GoMirrorPathCheck = { allowed: false, reason: 'shape' };

/** Whether a module path is well formed and starts with a listed host. */
function checkModule({ modulePath, hosts }: { modulePath: string; hosts: ReadonlySet<string> }): GoMirrorPathCheck {
  const elements = modulePath.split('/');
  const host = elements[0] ?? '';
  if (!isGoModuleHostName(host) || !elements.every(element => ESCAPED_NAME.test(element) && !element.endsWith('.'))) {
    return SHAPE;
  }
  return hosts.has(host) ? { allowed: true, path: modulePath } : { allowed: false, reason: 'host', host };
}

/** `<module>/@v/list`, `<module>/@v/<version>.info|.mod|.zip` and `<module>/@latest`, in decoded form. */
function checkProxyShape({ decoded, hosts }: { decoded: string; hosts: ReadonlySet<string> }): GoMirrorPathCheck {
  const marker = decoded.indexOf('/@');
  if (marker < 1) {
    return SHAPE;
  }
  const tail = decoded.slice(marker);
  let shaped = tail === '/@latest' || tail === '/@v/list';
  if (!shaped && tail.startsWith('/@v/')) {
    const file = PROXY_FILE.exec(tail.slice('/@v/'.length));
    shaped = file !== null && ESCAPED_NAME.test(file[1] ?? '');
  }
  if (!shaped) {
    return SHAPE;
  }
  const owner = checkModule({ modulePath: decoded.slice(1, marker), hosts });
  return owner.allowed ? { allowed: true, path: decoded } : owner;
}

/** `/supported`, `/latest`, `/lookup/<module>@<version>` and `/tile/...`, in decoded form. */
function checkSumdbShape({ decoded, hosts }: { decoded: string; hosts: ReadonlySet<string> }): GoMirrorPathCheck {
  if (decoded === '/supported' || decoded === '/latest' || TILE_PATH.test(decoded)) {
    return { allowed: true, path: decoded };
  }
  if (!decoded.startsWith('/lookup/')) {
    return SHAPE;
  }
  const named = decoded.slice('/lookup/'.length);
  const at = named.indexOf('@');
  if (at < 1 || !ESCAPED_NAME.test(named.slice(at + 1))) {
    return SHAPE;
  }
  const owner = checkModule({ modulePath: named.slice(0, at), hosts });
  return owner.allowed ? { allowed: true, path: decoded } : owner;
}

/**
 * Decides whether a Go mirror path may be fetched, and gives the canonical path to fetch. `rawRest` is
 * what follows `/go` on the request, still percent-encoded; it may be wrapped in `/via/<host>`.
 * Anything that is not a known address shape, or that does not decode to the plain lower-case form, is
 * refused.
 */
export function checkGoMirrorPath({
  rawRest,
  hosts,
}: {
  rawRest: string;
  hosts: ReadonlySet<string>;
}): GoMirrorPathCheck {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawRest);
  } catch {
    return SHAPE;
  }
  if (!DECODED_PATH.test(decoded)) {
    return SHAPE;
  }
  if (decoded.startsWith('/via/')) {
    const after = decoded.slice('/via/'.length);
    const slash = after.indexOf('/');
    const viaHost = slash === -1 ? '' : after.slice(0, slash);
    if (!isGoModuleHostName(viaHost)) {
      return SHAPE;
    }
    const inner = after.slice(slash);
    const proxy = checkProxyShape({ decoded: inner, hosts });
    const checked = proxy.allowed || proxy.reason === 'host' ? proxy : checkSumdbShape({ decoded: inner, hosts });
    return checked.allowed ? { allowed: true, path: `/via/${viaHost}${checked.path}` } : checked;
  }
  if (decoded.startsWith('/sumdb/')) {
    const after = decoded.slice('/sumdb/'.length);
    const slash = after.indexOf('/');
    if (slash === -1 || after.slice(0, slash) !== GO_SUMDB_NAME) {
      return SHAPE;
    }
    const checked = checkSumdbShape({ decoded: after.slice(slash), hosts });
    return checked.allowed ? { allowed: true, path: `/sumdb/${GO_SUMDB_NAME}${checked.path}` } : checked;
  }
  return checkProxyShape({ decoded, hosts });
}
