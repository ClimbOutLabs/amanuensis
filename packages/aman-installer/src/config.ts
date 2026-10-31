import { join } from 'node:path';

export interface InstallerConfig {
  // The state home on a host-folder system (Mac and Linux).
  stateHome: string;
  // The person's home folder: Docker keeps its settings file under it, and
  // the backup schedule is looked for under it, as the shell doctor does.
  homeDir: string;
  // The file that names the system (the shell doctor's AMAN_OS_RELEASE
  // override, else /etc/os-release): the Docker fix line differs on Debian
  // and Ubuntu, where the doctor can fix Docker itself.
  osReleasePath: string;
  // The folder holding Docker's settings file (DOCKER_CONFIG, else
  // ~/.docker).
  dockerConfigDir: string;
  // The compose service name of the app in an instance (the shell doctor's
  // AMAN_DOCTOR_APP_SERVICE, else app).
  appService: string;
  // The folder holding the computer's hardware names, which the setup
  // wizard reads for its cloud check; AMAN_DMI_DIR overrides it, mostly
  // for tests.
  dmiDir: string;
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
  const dockerConfig = options.env['DOCKER_CONFIG'];
  const osRelease = options.env['AMAN_OS_RELEASE'];
  const appService = options.env['AMAN_DOCTOR_APP_SERVICE'];
  const dmiDir = options.env['AMAN_DMI_DIR'];
  return {
    stateHome: fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(options.homeDir, '.amanuensis'),
    homeDir: options.homeDir,
    osReleasePath: osRelease !== undefined && osRelease !== '' ? osRelease : '/etc/os-release',
    dockerConfigDir:
      dockerConfig !== undefined && dockerConfig !== '' ? dockerConfig : join(options.homeDir, '.docker'),
    appService: appService !== undefined && appService !== '' ? appService : 'app',
    dmiDir: dmiDir !== undefined && dmiDir !== '' ? dmiDir : '/sys/class/dmi/id',
  };
}
