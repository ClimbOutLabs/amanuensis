import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const RECORD_FILE_NAME = 'image-verification.json';

/** What a cosign verification vouches for: this reference, this digest, this local image, this key. */
export const ImageVerificationSubjectSchema = z.object({
  image_ref: z.string().min(1),
  image_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  image_id: z.string().min(1),
  key_fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type ImageVerificationSubject = z.infer<typeof ImageVerificationSubjectSchema>;

/**
 * Persisted result of one successful cosign verification. It lets later
 * readiness probes skip the registry round trip, so it is trusted only when
 * every subject field equals what the probe observes locally right now.
 */
export const ImageVerificationRecordSchema = ImageVerificationSubjectSchema.extend({
  verified_at: z.iso.datetime(),
});
export type ImageVerificationRecord = z.infer<typeof ImageVerificationRecordSchema>;

export function imageVerificationRecordPath({ stateDir }: { stateDir: string }): string {
  return join(stateDir, RECORD_FILE_NAME);
}

/** A missing, unreadable, or malformed record reads as absent: the caller re-verifies. */
export async function readImageVerificationRecord({
  stateDir,
}: {
  stateDir: string;
}): Promise<ImageVerificationRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(imageVerificationRecordPath({ stateDir }), 'utf8');
  } catch {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = ImageVerificationRecordSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** Atomic replace, so a crash or a concurrent probe never leaves a half-written record. */
export async function writeImageVerificationRecord({
  stateDir,
  record,
}: {
  stateDir: string;
  record: ImageVerificationRecord;
}): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const finalPath = imageVerificationRecordPath({ stateDir });
  const tempPath = `${finalPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await rename(tempPath, finalPath);
  } catch (error: unknown) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export function recordVouchesForSubject({
  record,
  subject,
}: {
  record: ImageVerificationRecord | undefined;
  subject: ImageVerificationSubject;
}): boolean {
  return (
    record?.image_ref === subject.image_ref &&
    record.image_digest === subject.image_digest &&
    record.image_id === subject.image_id &&
    record.key_fingerprint === subject.key_fingerprint
  );
}

/**
 * SHA-256 over the key's DER SubjectPublicKeyInfo, so PEM whitespace and line
 * endings never change its identity. Undefined when the key cannot be read or
 * parsed; no record is trusted or written without a fingerprint.
 */
export async function cosignKeyFingerprint({ keyPath }: { keyPath: string }): Promise<string | undefined> {
  try {
    const der = createPublicKey(await readFile(keyPath)).export({ type: 'spki', format: 'der' });
    return `sha256:${createHash('sha256').update(der).digest('hex')}`;
  } catch {
    return undefined;
  }
}
