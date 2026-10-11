const RAW_ENTRY = /^\n?:([0-7]{6}) ([0-7]{6}) [0-9a-f]{40} [0-9a-f]{40} [A-Z][0-9]*$/u;

/**
 * A reason new commits must not be pushed from the sandbox, or undefined when they pass.
 * Input is the output of `git log -m --raw -z --no-abbrev --no-renames --format=%x01%H`: per commit a
 * "\x01<sha>" field, then for each changed path an entry field followed by the path field. The path field
 * is consumed with its entry, so a file name that imitates an entry cannot be misread.
 */
export function pushDiffProblem(rawDiffLog: string): string | undefined {
  const fields = rawDiffLog.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const entry = RAW_ENTRY.exec(fields[index] ?? '');
    if (entry === null) {
      continue;
    }
    const path = fields[index + 1] ?? '';
    index += 1;
    if (entry[1] === '160000' || entry[2] === '160000') {
      return `the new commits add or change a submodule (${path.slice(0, 80)})`;
    }
    if (path === '.gitmodules' || path.endsWith('/.gitmodules')) {
      return `the new commits change ${path.slice(0, 80)}`;
    }
  }
  return undefined;
}
