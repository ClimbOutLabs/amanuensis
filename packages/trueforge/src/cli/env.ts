/**
 * The CLI and the setup scripts run before, and without, the server config, which throws on missing env;
 * this is the one place they read the process environment.
 */
export type CliEnv = Readonly<Record<string, string | undefined>>;

export function processEnv(): CliEnv {
  return process.env;
}

/** For start-up only: gives the process a setting that was kept encrypted, before the server config reads it. */
export function setProcessEnv({ name, value }: { name: string; value: string }): void {
  process.env[name] = value;
}
