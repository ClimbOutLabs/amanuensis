/** Result of asking the host for the master key. A provider never creates a key. */
export type KeyLoadResult = { status: 'loaded'; key: Buffer } | { status: 'unavailable'; reason: string };

/** Supplies the master key from wherever this machine keeps it (TPM, keychain or key file). */
export interface KeyProvider {
  load(): Promise<KeyLoadResult>;
}
