import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  EMBEDDING_MODEL_FILES,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_REVISION,
} from '../../../../src/runtime/memory/embeddingModel';

// Both app images (the from-source one installs build, and the npm one) bake the memory search model in at
// build time. These pins must match the server's, so a model bump cannot leave an image on a different file
// than the one the server verifies.
const DOCKERFILES = ['Dockerfile', 'Dockerfile.dev'];

function readDockerfile(name: string): Promise<string> {
  return readFile(path.join(__dirname, '../../../../../..', name), 'utf8');
}

describe.each(DOCKERFILES)('%s bakes in the memory search model the server pins', dockerfile => {
  it.each(Object.entries(EMBEDDING_MODEL_FILES))('bakes in %s with its pinned SHA-256', async (relative, hash) => {
    const text = await readDockerfile(dockerfile);
    const url = `https://huggingface.co/${EMBEDDING_MODEL_ID}/resolve/${EMBEDDING_MODEL_REVISION}/${relative}`;
    expect(text).toContain(`--checksum=sha256:${hash} ${url} `);
  });

  it('keeps the redundant config.json next to the revision folder', async () => {
    const text = await readDockerfile(dockerfile);
    const hash = EMBEDDING_MODEL_FILES['config.json'];
    expect(text).toContain(
      `--checksum=sha256:${hash} https://huggingface.co/${EMBEDDING_MODEL_ID}/resolve/${EMBEDDING_MODEL_REVISION}/config.json /opt/aman-models/memory-search/${EMBEDDING_MODEL_ID}/config.json`,
    );
  });

  it('points the server at the baked-in folder', async () => {
    const text = await readDockerfile(dockerfile);
    expect(text).toContain('MEMORY_EMBEDDINGS_MODEL_DIR=/opt/aman-models/memory-search');
  });
});
