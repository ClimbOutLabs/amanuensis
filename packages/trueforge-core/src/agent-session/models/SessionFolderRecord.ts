/** Persisted owner-scoped chat folder. */
export interface SessionFolderRecord {
  tenant_id: string;
  folder_id: string;
  created_by: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}
