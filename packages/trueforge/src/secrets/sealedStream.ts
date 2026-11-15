import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { z } from 'zod';

import {
  MASTER_KEY_BYTES,
  SecretDecryptError,
  SecretKeyMismatchError,
  decryptSecret,
  encryptSecret,
  masterKeyId,
  type SecretContext,
} from './secretCipher';

const MAGIC = Buffer.from('AMANSEAL\x01', 'latin1');
const CHUNK_BYTES = 64 * 1024;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const MAX_HEADER_BYTES = 64 * 1024;

const SealedHeaderSchema = z.object({
  /** Random id of this sealed file; the wrapped data key is bound to it. */
  file_id: z.string().regex(/^[0-9a-f]{32}$/),
  /** Fingerprint of the machine key that wrapped the data key. */
  key_id: z.string().min(1),
  /** This file's own data key, encrypted with the machine key. */
  wrapped_key: z.string().min(1),
  /** The machine key encrypted with the recovery key, so the file opens on another machine. */
  recovery_copy: z.string().min(1).nullable(),
  chunk_bytes: z.number().int().positive().max(CHUNK_BYTES),
  created_at: z.string().min(1),
});

export type SealedHeader = z.infer<typeof SealedHeaderSchema>;

/** The data is not a sealed file, was cut short, or was changed after it was sealed. */
export class SealedFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SealedFileError';
  }
}

function dataKeyContext(fileId: string): SecretContext {
  return { table: 'sealed_file', primary_key: fileId, field: 'data_key' };
}

/** Counter nonce: safe because every sealed file has its own random data key. The last byte marks the final chunk. */
function chunkNonce({ index, final }: { index: bigint; final: boolean }): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES);
  nonce.writeBigUInt64BE(index, 0);
  nonce[NONCE_BYTES - 1] = final ? 1 : 0;
  return nonce;
}

function lengthPrefix(length: number): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(length, 0);
  return prefix;
}

/**
 * Seals a stream of bytes so that nothing in it can be read or changed without the machine key or
 * the recovery key. Yields the sealed bytes: a header, then the data in separately checked chunks,
 * the last one marked, so a file that was cut short or had chunks moved is refused.
 */
export async function* sealStream({
  source,
  masterKey,
  recoveryCopy,
  now = () => new Date(),
}: {
  source: AsyncIterable<Buffer>;
  masterKey: Buffer;
  recoveryCopy: string | null;
  now?: () => Date;
}): AsyncGenerator<Buffer> {
  const dataKey = randomBytes(MASTER_KEY_BYTES);
  const fileId = randomBytes(16).toString('hex');
  const header: SealedHeader = {
    file_id: fileId,
    key_id: masterKeyId(masterKey).toString('base64url'),
    wrapped_key: encryptSecret({
      key: masterKey,
      plaintext: dataKey.toString('base64'),
      context: dataKeyContext(fileId),
    }),
    recovery_copy: recoveryCopy,
    chunk_bytes: CHUNK_BYTES,
    created_at: now().toISOString(),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const preamble = Buffer.concat([MAGIC, lengthPrefix(headerBytes.length), headerBytes]);
  // Every chunk is checked together with the header, so a changed header fails the first chunk.
  const headerDigest = createHash('sha256').update(preamble).digest();
  yield preamble;

  const sealChunk = ({ plain, index, final }: { plain: Buffer; index: bigint; final: boolean }): Buffer => {
    const cipher = createCipheriv('aes-256-gcm', dataKey, chunkNonce({ index, final }), { authTagLength: TAG_BYTES });
    cipher.setAAD(headerDigest);
    const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    return Buffer.concat([lengthPrefix(body.length), body]);
  };

  let index = 0n;
  let pending: Buffer = Buffer.alloc(0);
  for await (const piece of source) {
    pending = pending.length === 0 ? piece : Buffer.concat([pending, piece]);
    while (pending.length > CHUNK_BYTES) {
      yield sealChunk({ plain: pending.subarray(0, CHUNK_BYTES), index, final: false });
      pending = pending.subarray(CHUNK_BYTES);
      index += 1n;
    }
  }
  yield sealChunk({ plain: pending, index, final: true });
}

/** Hands out exact byte counts from a stream that delivers pieces of any size. */
class ByteReader {
  readonly #iterator: AsyncIterator<Buffer>;
  #buffer: Buffer = Buffer.alloc(0);
  #ended = false;

  constructor(source: AsyncIterable<Buffer>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  /** Exactly `length` bytes, or undefined when the stream ended cleanly before any of them. */
  async read(length: number): Promise<Buffer | undefined> {
    while (this.#buffer.length < length && !this.#ended) {
      const next = await this.#iterator.next();
      if (next.done === true) {
        this.#ended = true;
      } else {
        this.#buffer = this.#buffer.length === 0 ? next.value : Buffer.concat([this.#buffer, next.value]);
      }
    }
    if (this.#buffer.length === 0 && length > 0) {
      return undefined;
    }
    if (this.#buffer.length < length) {
      throw new SealedFileError('The sealed file ends in the middle of a piece. It was cut short.');
    }
    const out = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return out;
  }
}

async function readHeader(reader: ByteReader): Promise<{ header: SealedHeader; headerDigest: Buffer }> {
  const magic = await reader.read(MAGIC.length);
  if (!magic?.equals(MAGIC)) {
    throw new SealedFileError('This is not a sealed Aman file.');
  }
  const prefix = await reader.read(4);
  const headerLength = prefix?.readUInt32BE(0) ?? 0;
  if (prefix === undefined || headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
    throw new SealedFileError('The sealed file has a damaged start.');
  }
  const headerBytes = await reader.read(headerLength);
  if (headerBytes === undefined) {
    throw new SealedFileError('The sealed file has a damaged start.');
  }
  let header: SealedHeader;
  try {
    header = SealedHeaderSchema.parse(JSON.parse(headerBytes.toString('utf8')));
  } catch (caught) {
    throw new SealedFileError('The sealed file has a damaged start.', { cause: caught });
  }
  const headerDigest = createHash('sha256').update(magic).update(prefix).update(headerBytes).digest();
  return { header, headerDigest };
}

/**
 * Opens a sealed stream. `resolveMasterKey` gets the header and returns the machine key, from the
 * host or from the header's recovery copy. Yields the original bytes; nothing from a chunk is
 * yielded before that chunk has passed its check. Callers MUST discard what they received when
 * this throws: a file cut at a chunk boundary is only known to be short at its end.
 */
export async function* openSealedStream({
  source,
  resolveMasterKey,
}: {
  source: AsyncIterable<Buffer>;
  resolveMasterKey: (header: SealedHeader) => Promise<Buffer> | Buffer;
}): AsyncGenerator<Buffer> {
  const reader = new ByteReader(source);
  const { header, headerDigest } = await readHeader(reader);
  const masterKey = await resolveMasterKey(header);
  let dataKey: Buffer;
  try {
    dataKey = Buffer.from(
      decryptSecret({ key: masterKey, value: header.wrapped_key, context: dataKeyContext(header.file_id) }),
      'base64',
    );
  } catch (caught) {
    if (caught instanceof SecretKeyMismatchError) {
      throw caught;
    }
    throw new SealedFileError('The sealed file was changed after it was made.', { cause: caught });
  }
  if (dataKey.length !== MASTER_KEY_BYTES) {
    throw new SealedFileError('The sealed file was changed after it was made.');
  }

  let index = 0n;
  let sawFinal = false;
  for (;;) {
    const prefix = await reader.read(4);
    if (prefix === undefined) {
      break;
    }
    if (sawFinal) {
      throw new SealedFileError('The sealed file has extra data after its end.');
    }
    const length = prefix.readUInt32BE(0);
    if (length < TAG_BYTES || length > header.chunk_bytes + TAG_BYTES) {
      throw new SealedFileError('The sealed file is damaged.');
    }
    const body = await reader.read(length);
    if (body === undefined) {
      throw new SealedFileError('The sealed file ends in the middle of a piece. It was cut short.');
    }
    // Only the last chunk may be shorter than a full one, so its length says which nonce to expect.
    const final = length < header.chunk_bytes + TAG_BYTES;
    let plain: Buffer | undefined;
    for (const candidate of final ? [true] : [false, true]) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', dataKey, chunkNonce({ index, final: candidate }), {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(headerDigest);
        decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
        plain = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
        sawFinal = candidate;
        break;
      } catch {
        plain = undefined;
      }
    }
    if (plain === undefined) {
      throw new SealedFileError('The sealed file was changed after it was made, or its pieces are out of order.', {
        cause: new SecretDecryptError(),
      });
    }
    index += 1n;
    if (plain.length > 0) {
      yield plain;
    }
  }
  if (!sawFinal) {
    throw new SealedFileError('The sealed file is missing its end. It was cut short.');
  }
}

/** Reads only the header of a sealed stream, for example to see which key it needs. */
export async function readSealedHeader(source: AsyncIterable<Buffer>): Promise<SealedHeader> {
  return (await readHeader(new ByteReader(source))).header;
}
