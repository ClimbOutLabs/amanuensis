import type { ImportDataResult } from '../../schemas/dataImport';

/** What the command needs from an opened instance; the real one writes to the configured SQLite database and files. */
export interface ImportDataSession {
  /** The instance's one account: the only user an import may be made for. */
  owner: string;
  importArchive(input: { archive: Buffer; userId: string; displayName: string }): Promise<ImportDataResult>;
  /** Records the completed import in the audit log, like the HTTP route does. */
  recordAudit(input: { userId: string; description: string }): Promise<void>;
  close(): Promise<void>;
}
