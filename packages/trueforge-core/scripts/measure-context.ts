/**
 * Base context bloat measurement (v1: static analysis).
 *
 * Reports token counts for static base-context sections (system prompt
 * constants, tool descriptions) so trimming work can be measured.
 * Run before and after trimming to see the reduction.
 *
 * Every row is computed from the live source constant, so the table tracks
 * description edits instead of going stale. Static code contributions only:
 * the rest of the base context is dynamic (MCP tool definitions, mounted skill
 * instructions, persona sections, the memory instruction block) and needs
 * runtime instrumentation.
 *
 * Usage (from packages/trueforge-core):
 *   pnpm measure:context
 */
import { estimateTokensForString } from '../src/core/llm/usage';
import {
  ABILITY_BOUNDARIES_PROMPT,
  createSourceDiscoveryContract,
  INTERNAL_SYSTEM_PROMPT,
  NO_TASK_NO_TOOLS_PROMPT,
  PLAIN_SPEECH_PROMPT,
  UNTRUSTED_TOOL_OUTPUT_PROMPT,
} from '../src/core/runtime/contextUtils';
import {
  createSandboxExecDescription,
  SANDBOX_APPLY_PATCH_DESCRIPTION,
  SANDBOX_REPLACE_TEXT_DESCRIPTION,
  SANDBOX_RUN_REGISTERED_COMMAND_DESCRIPTION,
  SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_DESCRIPTION,
  SANDBOX_WRITE_FILE_DESCRIPTION,
} from '../src/core/sandbox/Sandbox';

const tokens = (text: string): number => Math.round(estimateTokensForString(text));

interface Row {
  section: string;
  tokens: number;
}

// Static sections measurable without runtime instantiation.
const rows: Row[] = [
  { section: 'system: internal-messages', tokens: tokens(INTERNAL_SYSTEM_PROMPT) },
  { section: 'system: untrusted-tool-output', tokens: tokens(UNTRUSTED_TOOL_OUTPUT_PROMPT) },
  { section: 'system: source-discovery', tokens: tokens(createSourceDiscoveryContract({ shellCanFetch: true })) },
  { section: 'system: ability-boundaries', tokens: tokens(ABILITY_BOUNDARIES_PROMPT) },
  { section: 'system: no-task-no-tools', tokens: tokens(NO_TASK_NO_TOOLS_PROMPT) },
  { section: 'system: plain-speech', tokens: tokens(PLAIN_SPEECH_PROMPT) },
  { section: 'tool: sandbox exec description', tokens: tokens(createSandboxExecDescription({ offline: false })) },
  { section: 'tool: apply_patch description', tokens: tokens(SANDBOX_APPLY_PATCH_DESCRIPTION) },
  { section: 'tool: replace_text description', tokens: tokens(SANDBOX_REPLACE_TEXT_DESCRIPTION) },
  { section: 'tool: write_file description', tokens: tokens(SANDBOX_WRITE_FILE_DESCRIPTION) },
  {
    section: 'tool: run_registered_command description',
    tokens: tokens(SANDBOX_RUN_REGISTERED_COMMAND_DESCRIPTION),
  },
  { section: 'tool: submit_plan description', tokens: tokens(SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_DESCRIPTION) },
];

const total = rows.reduce((sum, { tokens }) => sum + tokens, 0);

console.log('Base context: static sections (v1)\n');
console.log(`Section${' '.repeat(34)}Tokens`);
console.log('-'.repeat(50));
for (const row of rows) {
  console.log(`${row.section.padEnd(42)}${String(row.tokens)}`);
}
console.log('-'.repeat(50));
console.log(`${'Static subtotal'.padEnd(42)}${String(total)}`);
console.log(`
Dynamic (measure live, not in v1):
  memory recalled content    <= 2560  (MEMORY_RECALL_MAX_TOKENS + ENTITY_TOKENS)
  MCP tool definitions       varies   (2 servers in prod; likely the bulk)
  skill instructions         varies   (mounted skills, e.g. web-artifacts-builder)
  persona / user sections    varies   (per-session)
  tool JSON schemas          varies   (~500+ estimated for sandbox alone)
`);
