import path from 'node:path';

import { EvalFixtureError } from '../../../src/eval/evalFixtureError';
import { buildEvalSources } from '../../../src/eval/fixtures';

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'evals', 'fixtures');
const RAW_DRAFT = Buffer.from(
  'To: Marcus Hale <marcus.hale@example.com>\r\nSubject: Re: Vendor review on Friday?\r\n\r\nFriday 6 November at 4 pm works.',
  'utf8',
).toString('base64url');

describe('EvalGmailApi', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('The eval fixtures must not reach the network.');
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('lists fixture threads by plain words and ignores operators', async () => {
    const { gmail } = buildEvalSources(FIXTURE_DIR);

    const matching = await gmail.listThreads({ query: 'vendor in:inbox', maxResults: 10, pageToken: undefined });
    const all = await gmail.listThreads({ query: '', maxResults: 10, pageToken: undefined });

    expect(matching.threadIds).toEqual(['thread-vendor-review']);
    expect(all.threadIds).toEqual(['thread-vendor-review', 'thread-pier-retrofit', 'thread-load-survey']);
  });

  it('returns headers only for a metadata read and the full text otherwise', async () => {
    const { gmail } = buildEvalSources(FIXTURE_DIR);

    const metadata = await gmail.getThread({ threadId: 'thread-vendor-review', format: 'metadata' });
    const full = await gmail.getThread({ threadId: 'thread-vendor-review', format: 'full' });

    expect(metadata.messages?.[0]?.payload?.body).toBeUndefined();
    expect(full.messages?.[0]?.payload?.body?.data).toBeDefined();
  });

  it('keeps a draft in memory and reads its headers back from the raw message', async () => {
    const { gmail } = buildEvalSources(FIXTURE_DIR);

    const created = await gmail.createDraft({ raw: RAW_DRAFT, threadId: 'thread-vendor-review' });
    const read = await gmail.getDraft(created.id);
    const drafts = await gmail.listDrafts({ maxResults: 10, pageToken: undefined });

    expect(read.message?.payload?.headers).toEqual([
      { name: 'To', value: 'Marcus Hale <marcus.hale@example.com>' },
      { name: 'Subject', value: 'Re: Vendor review on Friday?' },
    ]);
    expect(drafts.draftIds).toContain(created.id);
  });

  it('refuses to send, and never reaches the network', async () => {
    const { gmail } = buildEvalSources(FIXTURE_DIR);
    const created = await gmail.createDraft({ raw: RAW_DRAFT, threadId: undefined });

    await expect(gmail.sendDraft(created.id)).rejects.toBeInstanceOf(EvalFixtureError);
    await expect(gmail.getAttachment()).rejects.toBeInstanceOf(EvalFixtureError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
