import type { Writable } from 'node:stream';

import type { DataExportResult } from '../../dataExport/exportService';

/** One user that owns sessions. */
export interface SessionOwner {
  user_id: string;
  display_name: string;
  sessions: number;
}

/** What the command needs from an opened instance; the real one reads the configured stores. */
export interface ExportDataSession {
  /** Without sign-in, every session belongs to this one user id. */
  signInOffUserId: string | undefined;
  listOwners(): Promise<SessionOwner[]>;
  exportUser(input: {
    userId: string;
    includeUploads: boolean;
    includeInstanceData: boolean;
    out: Writable;
  }): Promise<DataExportResult>;
  /** Records one export (or failed attempt) in the audit log, with the actor `cli`. */
  recordAudit(input: { description: string }): Promise<void>;
  close(): Promise<void>;
}
