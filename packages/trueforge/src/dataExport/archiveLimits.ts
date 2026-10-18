/**
 * Size limits an export archive is written to and an import reads it with. Both sides use these
 * values, so an export never holds a file that the import of the same version refuses.
 */

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

/** Largest single file in an archive; import parses each JSON file whole. */
export const ARCHIVE_MAX_ENTRY_BYTES = 256 * MIB;

/** Default cap for a whole archive, for both DATA_EXPORT_MAX_BYTES and DATA_IMPORT_MAX_BYTES. */
export const ARCHIVE_DEFAULT_MAX_BYTES = GIB;

/** `935 MB`, `1.2 GB`: sizes in messages people read. */
export function formatArchiveBytes(bytes: number): string {
  if (bytes >= GIB) {
    return `${(bytes / GIB).toFixed(1).replace(/\.0$/, '')} GB`;
  }
  if (bytes >= MIB) {
    return `${String(Math.round(bytes / MIB))} MB`;
  }
  if (bytes >= KIB) {
    return `${String(Math.round(bytes / KIB))} KB`;
  }
  return `${String(bytes)} bytes`;
}
