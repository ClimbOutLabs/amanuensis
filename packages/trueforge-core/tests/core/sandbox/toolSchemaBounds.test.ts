import { ImplementationPlanSchema } from '../../../src/core/mcp/implementationPlanGrant';
import {
  sandboxApplyPatchSchema,
  sandboxExecSchema,
  sandboxReplaceTextSchema,
  sandboxRunRegisteredCommandSchema,
  sandboxWriteFileSchema,
} from '../../../src/core/sandbox/Sandbox';
import { RunCodeInputSchema } from '../../../src/core/sandbox/driver/RunCodeSchemas';

const LENGTH_KEYWORDS = new Set(['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']);

const TOOL_SCHEMAS: Array<{ name: string; schema: { toJSONSchema: (opts: { io: 'input' }) => unknown } }> = [
  { name: 'exec', schema: sandboxExecSchema },
  { name: 'run_code', schema: RunCodeInputSchema },
  { name: 'apply_patch', schema: sandboxApplyPatchSchema },
  { name: 'replace_text', schema: sandboxReplaceTextSchema },
  { name: 'write_file', schema: sandboxWriteFileSchema },
  { name: 'run_registered_command', schema: sandboxRunRegisteredCommandSchema },
  { name: 'submit_implementation_plan', schema: ImplementationPlanSchema },
];

function collectBoundOffenders(root: unknown): string[] {
  const limit = 128;
  const offenders: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${String(i)}]`));
      return;
    }
    if (typeof node !== 'object' || node === null) {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const here = `${path}.${key}`;
      if (LENGTH_KEYWORDS.has(key) && typeof value === 'number' && value > limit) {
        offenders.push(`${here}=${String(value)}`);
      }
      if (key === 'pattern' && typeof value === 'string') {
        for (const [, min, max] of value.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
          if (Number(max || min) > limit) {
            offenders.push(`${here} repeats ${max || min}`);
          }
        }
      }
      walk(value, here);
    }
  };
  walk(root, '$');
  return offenders;
}

describe('built-in tool JSON schemas', () => {
  it('emits no length bound above 128 to the model-facing JSON Schema', () => {
    // vLLM's cached xgrammar compile asserts on bounded repetitions above 128 and takes EngineCore down.
    // Keep limits in Zod .refine() (omitted from the JSON Schema) so parse-time validation still applies.
    const failures: string[] = [];
    for (const { name, schema } of TOOL_SCHEMAS) {
      const offenders = collectBoundOffenders(schema.toJSONSchema({ io: 'input' }));
      for (const offender of offenders) {
        failures.push(`${name}: ${offender}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
