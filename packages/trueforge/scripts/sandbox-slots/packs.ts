/**
 * Optional toolchain packs for the sandbox image. `go` and `rust` are downloaded here, on the host, and each
 * file is checked against the pinned SHA256SUMS before the image build sees it; `java` comes from the Ubuntu
 * archive during the build. The image build checks the archives again.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PACK_NAMES = ['go', 'rust', 'java'] as const;
export type PackName = (typeof PACK_NAMES)[number];

export function isPackName(value: string): value is PackName {
  return PACK_NAMES.some(name => name === value);
}

/** Splits `--add go,rust` style input; an unknown name is reported, not skipped. */
export function parsePackList(input: string): { packs: PackName[]; unknown: string[] } {
  const packs: PackName[] = [];
  const unknown: string[] = [];
  for (const item of input.split(',')) {
    const name = item.trim();
    if (name === '') {
      continue;
    }
    if (isPackName(name)) {
      if (!packs.includes(name)) {
        packs.push(name);
      }
    } else {
      unknown.push(name);
    }
  }
  return { packs, unknown };
}

/** The machine's CPU as `uname -m` and Docker's `.Architecture` report it. */
export type PackArch = 'x86_64' | 'aarch64';

export function toPackArch(dockerArchitecture: string): PackArch | undefined {
  const arch = dockerArchitecture.trim();
  return arch === 'x86_64' || arch === 'aarch64' ? arch : undefined;
}

const GO_VERSION = '1.27.2';
const RUST_VERSION = '1.99.0';
const RUST_DATE = '2026-10-01';
const GO_ARCH: Record<PackArch, string> = { x86_64: 'amd64', aarch64: 'arm64' };

interface PackFile {
  name: string;
  url: string;
}

/** Files a pack needs for one CPU. The Go toolchain module is verified by the Go checksum database as well. */
function packFiles({ pack, arch }: { pack: PackName; arch: PackArch }): PackFile[] {
  switch (pack) {
    case 'go': {
      const goArch = GO_ARCH[arch];
      return [
        {
          name: `go-${GO_VERSION}-linux-${goArch}.zip`,
          url: `https://proxy.golang.org/golang.org/toolchain/@v/v0.0.1-go${GO_VERSION}.linux-${goArch}.zip`,
        },
      ];
    }
    case 'rust':
      return ['rustc', 'cargo', 'rust-std'].map(component => {
        const name = `${component}-${RUST_VERSION}-${arch}-unknown-linux-gnu.tar.gz`;
        return { name, url: `https://static.rust-lang.org/dist/${RUST_DATE}/${name}` };
      });
    case 'java':
      return [];
  }
}

/** Every file name a pack can have, for either CPU, so removing a pack leaves nothing behind. */
export function allPackFileNames(pack: PackName): string[] {
  return (['x86_64', 'aarch64'] as const).flatMap(arch => packFiles({ pack, arch }).map(file => file.name));
}

export class PackError extends Error {
  constructor(
    message: string,
    readonly fix: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export interface PacksPort {
  /** Packs chosen earlier. */
  selected(): Promise<PackName[]>;
  /** Applies additions and removals, downloads and checks every file the result needs, and returns it. */
  prepare(input: { add: PackName[]; remove: PackName[]; arch: PackArch | undefined }): Promise<PackName[]>;
}

export type Download = (input: { url: string; destination: string }) => Promise<void>;

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Uint8Array);
  }
  return hash.digest('hex');
}

function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const [sum, name] = line.trim().split(/\s+/);
    if (sum !== undefined && name !== undefined && /^[0-9a-f]{64}$/.test(sum)) {
      sums.set(name, sum);
    }
  }
  return sums;
}

/** Packs live in `dir` (ops/sandbox-slot/packs): SHA256SUMS is pinned in the repo, archives/ and selected.json are local. */
export function createPacksPort({ dir, download }: { dir: string; download: Download }): PacksPort {
  const archives = join(dir, 'archives');
  const selectionFile = join(dir, 'selected.json');

  async function selected(): Promise<PackName[]> {
    let raw: string;
    try {
      raw = await readFile(selectionFile, 'utf8');
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is PackName => typeof item === 'string' && isPackName(item))
      : [];
  }

  async function ensureFile({ file, expected }: { file: PackFile; expected: string }): Promise<void> {
    const path = join(archives, file.name);
    try {
      if ((await sha256Of(path)) === expected) {
        return;
      }
    } catch {
      // Missing: fetched below.
    }
    const partial = `${path}.part`;
    await rm(partial, { force: true });
    try {
      await download({ url: file.url, destination: partial });
    } catch (error: unknown) {
      await rm(partial, { force: true });
      throw new PackError(
        `Downloading ${file.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        'Check that this machine can reach the download site, then run the command again.',
        error,
      );
    }
    if ((await sha256Of(partial)) !== expected) {
      await rm(partial, { force: true });
      throw new PackError(
        `${file.name} does not match its pinned checksum, so it was thrown away.`,
        'Run the command again; if it keeps failing, the download site or the network may be altering files, and the pack is not installed.',
      );
    }
    await rename(partial, path);
  }

  return {
    selected,
    async prepare({ add, remove, arch }) {
      const current = await selected();
      const next = PACK_NAMES.filter(name => (current.includes(name) || add.includes(name)) && !remove.includes(name));
      const sums = parseSums(await readFile(join(dir, 'SHA256SUMS'), 'utf8'));
      await mkdir(archives, { recursive: true });
      for (const dropped of PACK_NAMES.filter(name => !next.includes(name))) {
        for (const fileName of allPackFileNames(dropped)) {
          await rm(join(archives, fileName), { force: true });
        }
      }
      for (const pack of next) {
        if (arch === undefined && pack !== 'java') {
          throw new PackError(
            'The Docker host has a CPU the toolchain packs are not available for.',
            'Packs support x86_64 and aarch64 machines; run pnpm sandbox:slots --remove go,rust,java to go on without them.',
          );
        }
        for (const file of arch === undefined ? [] : packFiles({ pack, arch })) {
          const expected = sums.get(file.name);
          if (expected === undefined) {
            throw new PackError(
              `There is no pinned checksum for ${file.name}.`,
              'This checkout is missing ops/sandbox-slot/packs/SHA256SUMS lines; update the checkout and run the command again.',
            );
          }
          await ensureFile({ file, expected });
        }
      }
      await writeFile(selectionFile, `${JSON.stringify(next)}\n`);
      return next;
    },
  };
}
