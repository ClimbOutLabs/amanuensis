import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Where the terminal app keeps its own small files: the list of paired instances
 * and, only where no system keychain is offered, the file that holds the keys.
 * The folder is the person's own config folder, never the working directory.
 */
export function resolveConfigDir(options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === 'win32') {
    const appData = env.APPDATA;
    return path.join(
      appData === undefined || appData === '' ? path.join(homedir(), 'AppData', 'Roaming') : appData,
      'aman-tui',
    );
  }
  const xdg = env.XDG_CONFIG_HOME;
  return path.join(xdg === undefined || xdg === '' ? path.join(homedir(), '.config') : xdg, 'aman-tui');
}
