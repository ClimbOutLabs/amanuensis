/**
 * Trims the embedding dependency footprint after install.
 *
 * `onnxruntime-node` ships native binaries for every OS/arch (~290 MB); only
 * this machine's platform is ever loaded. `onnxruntime-web` (WASM, ~140 MB) is
 * a dependency of `@huggingface/transformers` but is never imported by its
 * Node build, which uses `onnxruntime-node`. Removing both brings the
 * embedding install from ~360 MB toward ~80 MB.
 *
 * `sharp` looks prunable (image processing, unused for text embeddings) but its
 * native binding is loaded eagerly by transformers' static `import sharp`, so
 * it must stay — verified by importing transformers with it removed.
 *
 * This never fails the install: any error is logged and the full (working)
 * install is left in place. pnpm hard-links the store into node_modules, so
 * removing files here only drops this install's links, never shared content.
 *
 * Wired as this package's `postinstall`.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read a package.json name without throwing. */
function manifestName(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))?.name;
  } catch {
    return undefined;
  }
}

/** Resolve symlinks; undefined when the path does not exist. */
function existingRealDir(candidate) {
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Real install dir of a package resolvable from this script: resolve its entry
 * through the `exports` map, then walk up to the dir whose package.json carries
 * the package name. The name check means we never delete a dir we did not mean to.
 */
async function scriptPackageDir(name) {
  let entry;
  try {
    entry = import.meta.resolve(name);
  } catch {
    return undefined;
  }
  let dir = path.dirname(fileURLToPath(entry));
  for (let i = 0; i < 6; i++) {
    if (manifestName(dir) === name) {
      return existingRealDir(dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
}

/**
 * Real install dir of `name` as seen from `fromDir`: checks
 * `<dir>/node_modules/<name>` walking up, which finds pnpm's nested links and
 * npm/yarn's hoisted dirs alike.
 */
function depPackageDir(fromDir, name) {
  let dir = fromDir;
  for (let i = 0; i < 12; i++) {
    const candidate = existingRealDir(path.join(dir, 'node_modules', name));
    if (candidate !== undefined && manifestName(candidate) === name) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
}

async function pruneOnnxruntimeNode() {
  const dir = await scriptPackageDir('onnxruntime-node');
  if (dir === undefined) {
    return;
  }
  const bin = path.join(dir, 'bin');
  let napiDirs;
  try {
    napiDirs = (await readdir(bin)).filter(name => name.startsWith('napi-'));
  } catch {
    return;
  }
  for (const napi of napiDirs) {
    const napiDir = path.join(bin, napi);
    let platforms;
    try {
      platforms = await readdir(napiDir);
    } catch {
      continue;
    }
    for (const platform of platforms) {
      const platformDir = path.join(napiDir, platform);
      if (platform === process.platform) {
        // Same OS: keep only this CPU architecture.
        let arches;
        try {
          arches = await readdir(platformDir);
        } catch {
          continue;
        }
        for (const arch of arches) {
          if (arch !== process.arch) {
            await rm(path.join(platformDir, arch), { recursive: true, force: true });
          }
        }
      } else {
        await rm(platformDir, { recursive: true, force: true });
      }
    }
  }
}

async function pruneOnnxruntimeWeb() {
  // The Node build of transformers.js never imports the WASM package; it is
  // bundled dead weight for a backend. Look it up from transformers' own dir.
  const transformersDir = await scriptPackageDir('@huggingface/transformers');
  if (transformersDir === undefined) {
    return;
  }
  const dir = depPackageDir(transformersDir, 'onnxruntime-web');
  if (dir === undefined) {
    return;
  }
  await rm(dir, { recursive: true, force: true });
}

try {
  await pruneOnnxruntimeNode();
  await pruneOnnxruntimeWeb();
} catch (error) {
  console.warn(`[prune-embedding-deps] skipped: ${error instanceof Error ? error.message : String(error)}`);
}
