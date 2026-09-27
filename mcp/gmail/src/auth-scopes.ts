// Resolve OAuth scopes for `gmail account auth`.
//
// Precedence (first match wins):
//   1. --scopes=foo,bar        CLI flag
//   2. GMAIL_SCOPES env var    same syntax
//   3. interactive checkbox    (TTY only)
//   4. DEFAULT_SCOPES          (non-interactive fallback)
//
// Interactive prompt is skipped when --non-interactive is passed,
// CI=<truthy> is set, GMAIL_AUTH_NON_INTERACTIVE=1 is set, or stdin
// is not a TTY (so callers spawning the process with piped stdin
// don't hang waiting for input).

import { checkbox } from "@inquirer/prompts";
import { DEFAULT_SCOPES, getAvailableScopeNames, parseScopes, validateScopes } from "./scopes.js";

export type ScopeSource = "cli" | "env" | "interactive" | "default";

export interface ResolveScopesInput {
  argv: string[];
  env: NodeJS.ProcessEnv;
  isTTY?: boolean;
  prompt?: typeof checkbox;
}

export interface ResolveScopesResult {
  scopes: string[];
  source: ScopeSource;
}

export class InvalidScopeError extends Error {
  code = "INVALID_SCOPE" as const;
  invalid: string[];
  constructor(invalid: string[]) {
    super(
      `Invalid scope(s): ${invalid.join(", ")}. Available: ${getAvailableScopeNames().join(", ")}`,
    );
    this.invalid = invalid;
    this.name = "InvalidScopeError";
  }
}

export function findCliScopesArg(argv: readonly string[]): string | null {
  const arg = argv.find((a) => a.startsWith("--scopes="));
  return arg ? arg.slice("--scopes=".length) : null;
}

export function isNonInteractive(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  isTTY: boolean,
): boolean {
  if (argv.includes("--non-interactive")) return true;
  if (env.GMAIL_AUTH_NON_INTERACTIVE === "1") return true;
  const ci = env.CI;
  if (ci && ci !== "" && ci !== "0" && ci.toLowerCase() !== "false") return true;
  if (!isTTY) return true;
  return false;
}

function validateOrThrow(scopes: string[]): string[] {
  const v = validateScopes(scopes);
  if (!v.valid) throw new InvalidScopeError(v.invalid);
  return scopes;
}

function describe(name: string): string {
  switch (name) {
    case "gmail.readonly":
      return "Read-only (subset of gmail.modify)";
    case "gmail.modify":
      return "Read + write, no send. Supersedes gmail.readonly and gmail.labels.";
    case "gmail.compose":
      return "Create drafts + send. Supersedes gmail.send.";
    case "gmail.send":
      return "Send only (subset of gmail.compose)";
    case "gmail.labels":
      return "Manage labels only (subset of gmail.modify)";
    case "gmail.full":
      return "Full mailbox access, including permanent deletion. Does not include settings.";
    case "gmail.settings.basic":
      return "Manage filters and basic settings";
    case "gmail.settings.sharing":
      return "Manage delegation/sharing settings (rare)";
    default:
      return "";
  }
}

export async function resolveScopes(input: ResolveScopesInput): Promise<ResolveScopesResult> {
  const argv = input.argv;
  const env = input.env;
  const isTTY = input.isTTY ?? Boolean(process.stdin.isTTY);
  const prompt = input.prompt ?? checkbox;

  const cliVal = findCliScopesArg(argv);
  if (cliVal !== null) {
    return { scopes: validateOrThrow(parseScopes(cliVal)), source: "cli" };
  }

  const envVal = env.GMAIL_SCOPES;
  if (envVal && envVal.trim().length > 0) {
    return { scopes: validateOrThrow(parseScopes(envVal)), source: "env" };
  }

  if (isNonInteractive(argv, env, isTTY)) {
    return { scopes: [...DEFAULT_SCOPES], source: "default" };
  }

  const all = getAvailableScopeNames();
  const choices = all.map((name) => ({
    value: name,
    name: DEFAULT_SCOPES.includes(name) ? `${name}  (default)` : name,
    checked: DEFAULT_SCOPES.includes(name),
    description: describe(name),
  }));

  const selected = await prompt({
    message: "Select Gmail OAuth scopes (space=toggle, a=all, i=invert, enter=confirm)",
    choices,
    required: true,
    pageSize: all.length,
  });

  return { scopes: selected, source: "interactive" };
}
