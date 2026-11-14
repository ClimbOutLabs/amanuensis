import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { approvedMailDraftsPath, fileApprovedMailDrafts } from '../../../src/runtime/mailApprovedDrafts';

describe('approved Email drafts kept in a file', () => {
  let dir: string;
  let path: string;
  const DRAFT = { tenant_id: 't1', created_by: 'u1', key: 'draft-key-1' };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'approved-drafts-'));
    path = approvedMailDraftsPath(join(dir, 'allowed_recipients.json'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('approves nothing until a draft is added', async () => {
    expect(await fileApprovedMailDrafts({ path }).has(DRAFT)).toBe(false);
  });

  it('still holds an approved draft after a restart', async () => {
    await fileApprovedMailDrafts({ path }).add(DRAFT);
    expect(await fileApprovedMailDrafts({ path }).has(DRAFT)).toBe(true);
  });

  it("keeps one person's draft from approving another person's send", async () => {
    const drafts = fileApprovedMailDrafts({ path });
    await drafts.add(DRAFT);
    expect(await drafts.has({ ...DRAFT, created_by: 'u2' })).toBe(false);
    expect(await drafts.has({ ...DRAFT, tenant_id: 't2' })).toBe(false);
  });

  it('gives a draft to one taker only, and forgets it', async () => {
    const drafts = fileApprovedMailDrafts({ path });
    await drafts.add(DRAFT);
    expect(await Promise.all([drafts.take(DRAFT), drafts.take(DRAFT)])).toEqual([true, false]);
    expect(await drafts.has(DRAFT)).toBe(false);
  });

  it('keeps every draft when several are added at once', async () => {
    const drafts = fileApprovedMailDrafts({ path });
    const many = Array.from({ length: 8 }, (_, index) => ({ ...DRAFT, key: `draft-key-${String(index)}` }));
    await Promise.all(many.map(draft => drafts.add(draft)));
    expect(await Promise.all(many.map(draft => drafts.has(draft)))).toEqual(many.map(() => true));
  });

  it('forgets a draft nobody sent for a month', async () => {
    let time = Date.parse('2026-11-01T00:00:00Z');
    const drafts = fileApprovedMailDrafts({ path, now: () => time });
    await drafts.add(DRAFT);
    time += 31 * 24 * 60 * 60 * 1000;
    expect(await drafts.has(DRAFT)).toBe(false);
  });

  it('approves nothing from a damaged file', async () => {
    await writeFile(path, 'not json');
    expect(await fileApprovedMailDrafts({ path }).has(DRAFT)).toBe(false);
  });

  it('writes no address, subject or text to the file', async () => {
    await fileApprovedMailDrafts({ path }).add({ ...DRAFT, key: 'nora@example.com Saturday dinner' });
    const saved = await readFile(path, 'utf8');
    expect(saved).not.toContain('nora@example.com');
    expect(saved).not.toContain('Saturday');
  });
});
