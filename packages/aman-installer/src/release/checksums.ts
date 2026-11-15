import { sha256Hex } from './manifest.ts';

// The SHA256SUMS text: one line per file, the hash, two spaces and the
// name, sorted by name. It is the format sha256sum --check reads, so a
// person on Linux or a Mac can check every download with one command.
export function checksumsText(files: readonly { name: string; data: Uint8Array }[]): string {
  const lines = files
    .map(file => ({ name: file.name, hash: sha256Hex(file.data) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(file => `${file.hash}  ${file.name}\n`);
  return lines.join('');
}
