// The smoke stack reads packages/trueforge/.env, which only developers create. Without it Compose stops with a
// raw error about an env file; this prints one plain line that points a person who just wants to install Aman to the installer.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SMOKE_ENV_FILE = 'packages/trueforge/.env';

export function smokeEnvProblem({ exists }) {
  if (exists) {
    return undefined;
  }
  return `${SMOKE_ENV_FILE} does not exist. To install Aman, run installer/install.sh; it needs no file of yours. This smoke stack is for developers: copy packages/trueforge/.env.example to ${SMOKE_ENV_FILE}.`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problem = smokeEnvProblem({ exists: existsSync(SMOKE_ENV_FILE) });
  if (problem !== undefined) {
    process.stderr.write(`${problem}\n`);
    process.exit(1);
  }
}
