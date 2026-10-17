import path from 'node:path';
import { extractStructuredEditPaths } from '../sandbox/structuredEditPaths';
import type { PathResolution } from './trackedExecutables';

export type ApplyPatchTargets = { status: 'valid'; paths: string[] } | { status: 'invalid'; reason: string };

/**
 * The files an apply_patch call changes, read from the patch itself and made workspace-relative.
 * The tool takes no path or target argument, so one present is a decoy for the approval card and is
 * refused; a patch or cwd that leaves the workspace root is invalid.
 */
export function applyPatchTargets(input: {
  params: Record<string, unknown>;
  workspace_root: string;
  cwd: string;
}): ApplyPatchTargets {
  if (Object.hasOwn(input.params, 'path') || Object.hasOwn(input.params, 'target')) {
    return { status: 'invalid', reason: 'apply_patch takes its targets from the patch, not from a path argument.' };
  }
  const patch = input.params['patch'];
  if (typeof patch !== 'string') {
    return { status: 'invalid', reason: 'apply_patch needs a patch.' };
  }
  const resolution = extractStructuredEditPaths({
    kind: 'apply_patch',
    repositoryRoot: input.workspace_root,
    cwd: input.cwd,
    patch,
  });
  return resolution.status === 'valid'
    ? { status: 'valid', paths: resolution.paths }
    : { status: 'invalid', reason: 'The patch or its working directory is not confined to the workspace.' };
}

/** A workspace-relative patch target as an absolute path, joined the way the call's filesystem is read. */
export function absolutePatchTarget(input: {
  workspace_root: string;
  relative_path: string;
  resolution: PathResolution | undefined;
}): string {
  return input.resolution === 'remote'
    ? path.posix.join(input.workspace_root, input.relative_path)
    : path.join(input.workspace_root, input.relative_path);
}
