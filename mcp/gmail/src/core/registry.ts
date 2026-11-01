// Operation registry — single source of truth for tool dispatch.
//
// Replaces the giant `switch (name)` in src/index.ts. Each per-category file
// under src/core/ops/ registers its operations here at module load time;
// the dispatcher looks up by name and runs handler(input, ctx).
//
// Migration is progressive — until every op is registered, the dispatcher
// in src/index.ts falls through to its switch for any unregistered name.
// Use `has()` to gate that fallthrough.

import type { z } from "zod";
import type { OperationContext } from "./context.js";

/**
 * MCP-compatible response envelope. `content` keeps the wire-protocol text/image
 * payload; `structuredContent` carries the typed-output JSON when the op
 * declares an `outputSchema`. CLI/TUI consumers use structuredContent when
 * available; MCP hosts that respect outputSchema get type info.
 */
export type OperationContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface OperationResult<TOutput = unknown> {
  content: OperationContent[];
  isError?: boolean;
  structuredContent?: TOutput;
}

export interface Operation<TInput = unknown, TOutput = unknown> {
  /** Matches the tool name in src/tools.ts. */
  name: string;
  /** Zod schema used to parse `args` before the handler runs. */
  schema: z.ZodType<TInput>;
  /**
   * Optional typed-output schema. When set, the handler is expected to populate
   * `structuredContent: z.infer<typeof outputSchema>` on its return; CLI's
   * --json mode emits structuredContent directly. Ops without an outputSchema
   * stay text-only (set `structuredContent` to whatever shape they like, or
   * omit it entirely).
   */
  outputSchema?: z.ZodType<TOutput>;
  /** Scopes mirrored from tools.ts — for runtime auth gating sanity. */
  scopes: string[];
  /** Pure async function. Throws on Gmail/transport errors — the dispatcher
   *  wraps via auth-errors.wrapToolError. */
  handler: (input: TInput, ctx: OperationContext) => Promise<OperationResult<TOutput>>;
}

export class OperationRegistry {
  private ops = new Map<string, Operation<any>>();

  register<T>(op: Operation<T>): void {
    if (this.ops.has(op.name)) {
      throw new Error(`OperationRegistry: duplicate registration for "${op.name}"`);
    }
    this.ops.set(op.name, op as Operation<any>);
  }

  has(name: string): boolean {
    return this.ops.has(name);
  }

  get(name: string): Operation<any> | undefined {
    return this.ops.get(name);
  }

  names(): string[] {
    return Array.from(this.ops.keys());
  }

  /**
   * Parse args via the op's schema, then run the handler. Schema errors
   * propagate as zod ZodError — the dispatcher converts to a tool-error
   * MCP response with the wrapToolError formatter.
   */
  async dispatch(name: string, rawArgs: unknown, ctx: OperationContext): Promise<OperationResult> {
    const op = this.ops.get(name);
    if (!op) {
      throw new Error(`OperationRegistry: no op registered for "${name}"`);
    }
    // Omitted args (undefined/null) parse as {} so no-argument ops
    // (health_check, list_accounts, …) work when the caller sends no params.
    // Schemas with required fields still reject {} with a proper ZodError.
    const input = op.schema.parse(rawArgs ?? {});
    return op.handler(input, ctx);
  }
}

/**
 * Process-wide registry singleton. Per-category files import this and call
 * `register(...)` at module load.
 */
export const registry = new OperationRegistry();
