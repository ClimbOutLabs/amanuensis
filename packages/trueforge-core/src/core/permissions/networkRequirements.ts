/**
 * The `requires_network` declaration for Sentinel offline mode.
 *
 * Every tool declares, where it is registered, whether it needs the network, alongside the
 * other per-tool metadata its tool set carries. Offline mode reads that declaration: it
 * filters the model-visible tool list and blocks calls at call time. There is no side table
 * of tool names here, so a tool that gains a network path changes its own declaration in the
 * same change, and a new tool is born with its declaration made.
 *
 * A call whose tool declared nothing is read as needing the network. For a tool another
 * server serves that is the standing rule (its registration is not Aman's to make). For a
 * first-party tool it is a registration error: `defineTool` requires the declaration, and a
 * tool set that lists a tool without one fails loudly rather than defaulting silently.
 */

/**
 * Whether a call needs the network, from the declaration the tool's own registration made.
 * An absent declaration reads as true: the call is blocked offline rather than let through
 * on a guess.
 */
export function requiresNetwork(input: { declared: boolean | undefined }): boolean {
  return input.declared ?? true;
}
