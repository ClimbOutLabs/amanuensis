import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run from a package's prepack so published tarballs always carry the root LICENSE and NOTICE.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['LICENSE', 'NOTICE']) {
  copyFileSync(path.join(repoRoot, name), path.join(process.cwd(), name));
}
