/**
 * The CLI runs before, and without, the server config, which throws on missing env;
 * this is the one place the CLI reads the process environment.
 */
export type CliEnv = Readonly<Record<string, string | undefined>>;

export function processEnv(): CliEnv {
  return process.env;
}
