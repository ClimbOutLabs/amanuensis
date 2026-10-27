import { join } from 'node:path';

export interface InstallerConfig {
  // The state home on a host-folder system (Mac and Linux).
  stateHome: string;
}

// The one place the installer's environment settings are read. AMANUENSIS_HOME
// is the doctor shim's rule: when set, it names the state home; otherwise the
// home is ~/.amanuensis. The caller passes the environment in, so the entry
// point is the only code that touches the process.
export function installerConfig(options: {
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
}): InstallerConfig {
  const fromEnv = options.env['AMANUENSIS_HOME'];
  return { stateHome: fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(options.homeDir, '.amanuensis') };
}
