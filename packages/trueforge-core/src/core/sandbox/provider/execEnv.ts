import { join } from 'node:path/posix';

function resolveMaybeRelative(params: { root: string; path: string }): string {
  return params.path.startsWith('/') ? params.path : join(params.root, params.path);
}

/** Make cwd-relative PATH / PYTHONPATH / TFY_SKILLS_DIR usable from any cwd. */
export function absolutizeRelativeExecEnv(params: {
  root: string;
  env: Record<string, string>;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.env)) {
    if (key === 'PATH' || key === 'PYTHONPATH') {
      out[key] = value
        .split(':')
        .map(part => (part.length === 0 ? part : resolveMaybeRelative({ root: params.root, path: part })))
        .join(':');
      continue;
    }
    if (key === 'TFY_SKILLS_DIR' || key === 'VIRTUAL_ENV') {
      out[key] = resolveMaybeRelative({ root: params.root, path: value });
      continue;
    }
    out[key] = value;
  }
  return out;
}
