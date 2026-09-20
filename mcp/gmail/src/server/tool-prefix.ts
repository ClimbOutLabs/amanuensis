/** Resolve MCP-only tool name prefix. CLI flag wins over the environment. */
export function resolveToolPrefix(args: readonly string[], env: NodeJS.ProcessEnv): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg.startsWith("--tool-prefix=")) return arg.slice("--tool-prefix=".length);
    if (arg === "--tool-prefix") return args[index + 1] ?? "";
  }
  return env.GMAIL_MCP_TOOL_PREFIX ?? "";
}

export function prefixedToolName(name: string, prefix: string): string {
  return `${prefix}${name}`;
}

export function canonicalToolName(name: string, prefix: string): string {
  if (!prefix || !name.startsWith(prefix)) return name;
  const candidate = name.slice(prefix.length);
  return candidate;
}
