import { z } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { shellEscape } from './provider/Provider';

const HEX_SHA256 = /^[0-9a-f]{64}$/;

export const StructuredEditTargetSchema = z.object({
  path: z.string().min(1),
  state: z.enum(['present', 'missing']),
  byte_length: z.number().int().nonnegative(),
  sha256: z.string().regex(HEX_SHA256),
});

export const StructuredEditPreconditionSchema = z.object({
  kind: z.enum(['replace_text', 'apply_patch']),
  targets: z.array(StructuredEditTargetSchema).min(1),
  target_state_sha256: z.string().regex(HEX_SHA256),
  summary: z.string().min(1),
});

export type StructuredEditTarget = z.infer<typeof StructuredEditTargetSchema>;
export type StructuredEditPrecondition = z.infer<typeof StructuredEditPreconditionSchema>;

const STRUCTURED_EDIT_OBSERVATION_SCRIPT = [
  'import hashlib,json,os,sys',
  'kind,root,paths=sys.argv[1],sys.argv[2],json.loads(sys.argv[3])',
  'targets=[]',
  'for path in sorted(set(paths)):',
  ' target=os.path.join(root,path)',
  ' if not os.path.isfile(target):',
  "  targets.append({'path':path,'state':'missing','byte_length':0,'sha256':hashlib.sha256(b'').hexdigest()})",
  '  continue',
  'digest=hashlib.sha256(); size=0',
  "with open(target,'rb') as handle:",
  ' while True:',
  '  chunk=handle.read(1024*1024)',
  '  if not chunk: break',
  '  digest.update(chunk); size += len(chunk)',
  "targets.append({'path':path,'state':'present','byte_length':size,'sha256':digest.hexdigest()})",
  "print(json.dumps({'kind':kind,'targets':targets},separators=(',',':')))",
].join('\n');

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalTargets(targets: readonly StructuredEditTarget[]): string {
  return JSON.stringify([...targets].sort((left, right) => comparePaths(left.path, right.path)));
}

function targetStateHash(targets: readonly StructuredEditTarget[]): string {
  return createHash('sha256').update(canonicalTargets(targets), 'utf8').digest('hex');
}

function buildSummary(kind: StructuredEditPrecondition['kind'], targets: readonly StructuredEditTarget[]): string {
  const targetSummary = [...targets]
    .sort((left, right) => comparePaths(left.path, right.path))
    .map(
      target =>
        `${target.path} ${target.state}, ${String(target.byte_length)} bytes, sha256 ${target.sha256.slice(0, 12)}`,
    )
    .join('; ');
  return `Host observed ${kind} targets before approval. The edit is bound to these complete target bytes: ${targetSummary}.`;
}

export function buildStructuredEditObservationCommand(input: {
  kind: StructuredEditPrecondition['kind'];
  workspaceRoot: string;
  paths: readonly string[];
}): string {
  const kind = input.kind;
  const paths = [...new Set(input.paths)].sort(comparePaths);
  return `python3 -I -S -c ${shellEscape(STRUCTURED_EDIT_OBSERVATION_SCRIPT)} ${shellEscape(kind)} ${shellEscape(input.workspaceRoot)} ${shellEscape(JSON.stringify(paths))}`;
}

export function parseStructuredEditObservation(
  raw: string,
  expectedPaths: readonly string[],
): StructuredEditPrecondition {
  const parsed: unknown = JSON.parse(raw);
  const envelope = z
    .object({ kind: z.enum(['replace_text', 'apply_patch']), targets: z.array(StructuredEditTargetSchema).min(1) })
    .parse(parsed);
  const targets = [...envelope.targets].sort((left, right) => comparePaths(left.path, right.path));
  const normalizedExpectedPaths = [...new Set(expectedPaths)].sort(comparePaths);
  if (
    targets.length !== normalizedExpectedPaths.length ||
    targets.some((target, index) => target.path !== normalizedExpectedPaths[index])
  ) {
    throw new Error('Structured-edit target observation did not match the requested paths.');
  }
  return structuredEditObservationForTargets({
    kind: envelope.kind,
    targets,
  });
}

export function structuredEditObservationForTargets(input: {
  kind: StructuredEditPrecondition['kind'];
  targets: readonly StructuredEditTarget[];
}): StructuredEditPrecondition {
  const targets = [...input.targets].sort((left, right) => comparePaths(left.path, right.path));
  return StructuredEditPreconditionSchema.parse({
    kind: input.kind,
    targets,
    target_state_sha256: targetStateHash(targets),
    summary: buildSummary(input.kind, targets),
  });
}

export function structuredEditObservationMatches(
  approved: StructuredEditPrecondition,
  current: StructuredEditPrecondition,
): boolean {
  return approved.kind === current.kind && approved.target_state_sha256 === current.target_state_sha256;
}
