// The Windows host's install picks: the ports it hands the installer and
// the starter's install command line it hands them on. The starter's
// PowerShell did both on the PC, because the setup container cannot see
// the PC's ports; this module is that rule, moved, not changed (plan
// section 3).

// The candidates, in the plan's order: the app, the sign-in service and
// the https port.
export const DEFAULT_APP_PORT = 8791;
export const DEFAULT_LOGIN_PORT = 5556;
export const DEFAULT_TLS_PORT = 8443;

// Ports the installer itself keeps inside the instance (installer/lib/
// ports.sh): a host pick must never land on one, since install.sh would
// refuse it as its own.
const INSTALLER_RESERVED_PORTS: readonly number[] = [8790, 5558];

// How far above a candidate the search reaches, the shell's own limit
// (pick_port in installer/lib/ports.sh).
const PORT_SEARCH_LIMIT = 300;

export class NoFreePortError extends Error {}

async function firstFreePort(options: {
  isFree: (port: number) => Promise<boolean>;
  start: number;
  reserved: readonly number[];
}): Promise<number> {
  for (let port = options.start; port < options.start + PORT_SEARCH_LIMIT && port <= 65535; port += 1) {
    if (INSTALLER_RESERVED_PORTS.includes(port) || options.reserved.includes(port)) {
      continue;
    }
    if (await options.isFree(port)) {
      return port;
    }
  }
  throw new NoFreePortError(`no free port at or above ${String(options.start)} on this computer`);
}

// The pair install.sh would pick, picked on the Windows host where the
// real ports can be bound: each port is the first free one at or above
// its candidate, and an earlier pick is reserved against the later ones.
export async function pickInstallPorts(options: {
  isFree: (port: number) => Promise<boolean>;
}): Promise<{ appPort: number; loginPort: number; tlsPort: number }> {
  const appPort = await firstFreePort({ isFree: options.isFree, start: DEFAULT_APP_PORT, reserved: [] });
  const loginPort = await firstFreePort({ isFree: options.isFree, start: DEFAULT_LOGIN_PORT, reserved: [appPort] });
  const tlsPort = await firstFreePort({
    isFree: options.isFree,
    start: DEFAULT_TLS_PORT,
    reserved: [appPort, loginPort],
  });
  return { appPort, loginPort, tlsPort };
}

// The starter's whole contract with the installer (the starter spec):
// one command line, secrets on standard input. The port flags ride
// along only when the picked pair is not the first pair, as the starter
// hands them: the plain line is the frozen contract.
export function starterInstallArgs(options: { email: string; appPort: number; loginPort: number }): string[] {
  const args = [
    'installer/install.sh',
    '--yes',
    '--local-only',
    '--backups',
    'off',
    '--name',
    'main',
    '--email',
    options.email,
    '--password-stdin',
    '--token-factory-key-stdin',
  ];
  if (options.appPort !== DEFAULT_APP_PORT || options.loginPort !== DEFAULT_LOGIN_PORT) {
    args.push('--port', String(options.appPort), '--login-port', String(options.loginPort));
  }
  return args;
}

// The first install's command line: the starter's line, with the
// pieces the native install adds. The instance is made with the local
// authority (--tls local) at this computer's own name (--address
// localhost), so there is no --local-only (the two are opposites to
// the installer), and the backups are daily from the first day. The
// key flag is there only when a key was given: the installer refuses
// an empty key line, and an install with no key is a plain install.
// The port flags follow the starter's rule, as above.
export function firstInstallArgs(options: {
  email: string;
  appPort: number;
  loginPort: number;
  hasKey: boolean;
}): string[] {
  const args = ['installer/install.sh', '--yes', '--name', 'main', '--email', options.email, '--password-stdin'];
  if (options.hasKey) {
    args.push('--token-factory-key-stdin');
  }
  args.push('--tls', 'local', '--address', 'localhost', '--backups', 'daily');
  if (options.appPort !== DEFAULT_APP_PORT || options.loginPort !== DEFAULT_LOGIN_PORT) {
    args.push('--port', String(options.appPort), '--login-port', String(options.loginPort));
  }
  return args;
}
