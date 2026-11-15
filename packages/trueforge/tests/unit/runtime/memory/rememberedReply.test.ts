import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { hasReadContent, type ChatProvenance } from '@truefoundry/trueforge-core/core/permissions/provenance';
import { createWebSearchTurnState } from '@truefoundry/trueforge-core/core/permissions/webSearch';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { entryMetadata, formatRetainEntry } from '../../../../src/runtime/memory/markdownMemoryFiles';
import { memoryCapability } from '../../../../src/runtime/memory/memoryCapability';
import type { RecallOutcome, RetainItem } from '../../../../src/runtime/memory/memoryClient';
import {
  ASSISTANT_RESPONSE_SOURCE,
  formatMarker,
  isReplyThatReadNothing,
  labeledNoteText,
  noteLabel,
  type MemoryNoteSource,
} from '../../../../src/runtime/memory/memoryNotes';
import { IMPORTED_ORIGIN, MEMORY_ORIGIN_METADATA_KEY } from '../../../../src/runtime/memory/memoryOrigin';
import { noteRetainItem } from '../../../../src/runtime/memory/memoryRetain';
import { collect, DEFAULT_CONFIG, makeExecution, makeLogger } from './memoryCapabilityTestKit';

const DAY = '2026-11-10';
const SAVED_AT = `${DAY}T12:00:00.000Z`;
const GUIDE_SITE = 'guide.example';
const GUIDE_LINK = `https://${GUIDE_SITE}/camping/`;
const GUIDE_ADDRESS = 'desk@guide.example';
const REPLY_TEXT = `The camping guide is at ${GUIDE_LINK}. Write to ${GUIDE_ADDRESS} to book.`;
/** The closing lines the store writes on a reply from a chat that had read nothing. */
const MARK_LINES = [
  formatMarker({ kind: 'note', source: ASSISTANT_RESPONSE_SOURCE, date: DAY }),
  '> External source: assistant reply, nothing read before it',
].join('\n\n');

function note({
  source,
  text,
  chatReadNothing,
}: {
  source: MemoryNoteSource;
  text: string;
  chatReadNothing: boolean;
}): RetainItem {
  return noteRetainItem({
    sessionId: 'earlier-chat',
    turnId: 't1',
    completedAt: SAVED_AT,
    note: {
      source,
      date: DAY,
      text: labeledNoteText({ label: noteLabel({ source, date: DAY, assistantName: undefined }), text }),
    },
    documentId: 'doc-1',
    chatReadNothing,
  });
}

/** Saves the items in a real store, recalls them into a new chat, and hands back what that chat now holds. */
async function recalledInANewChat(input: {
  items: RetainItem[];
  edit?: string;
}): Promise<{ provenance: ChatProvenance; metadata: (Record<string, string> | undefined)[] }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'remembered-reply-'));
  try {
    const client = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-1' });
    await client.retain({ items: input.items, operationId: 'op-1', timeoutMs: 5000 });
    if (input.edit !== undefined) {
      const listed = await client.listEntries({ namespace: '', timeoutMs: 5000 });
      const entryId = listed.ok ? listed.entries[0]?.id : undefined;
      if (entryId === undefined) {
        throw new Error('expected one saved entry to edit');
      }
      await client.updateEntry({ entryId, text: input.edit, timeoutMs: 5000 });
    }
    const webSearch = createWebSearchTurnState();
    const recall = jest.spyOn(client, 'recall');
    const capability = memoryCapability({
      client,
      config: DEFAULT_CONFIG,
      logger: makeLogger(),
      sessionId: 'new-chat',
      previousTurnId: null,
      webSearch,
    });
    const processor = capability.preLLMProcessors?.[0];
    if (!processor) {
      throw new Error('expected a preLLM processor');
    }
    await collect(processor.processPreLLM(makeExecution([{ role: 'user', content: 'where is the camping guide' }])));
    const outcome: RecallOutcome | undefined = await recall.mock.results[0]?.value;
    const metadata = outcome?.ok === true ? outcome.results.map(item => item.metadata) : [];
    return { provenance: webSearch.provenance, metadata };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('a reply Aman remembers from an earlier chat', () => {
  it('does not make the new chat count as having read outside content when the earlier chat had read nothing', async () => {
    const { provenance, metadata } = await recalledInANewChat({
      items: [note({ source: ASSISTANT_RESPONSE_SOURCE, text: REPLY_TEXT, chatReadNothing: true })],
    });

    expect(metadata.map(isReplyThatReadNothing)).toEqual([true]);
    expect(metadata[0]?.[MEMORY_ORIGIN_METADATA_KEY]).toBe('tool_ingested');
    expect(hasReadContent(provenance)).toBe(false);
    expect(provenance.reply.hosts.has(GUIDE_SITE)).toBe(true);
    expect(provenance.untrusted.hosts.has(GUIDE_SITE)).toBe(false);
    expect(provenance.trusted.hosts.has(GUIDE_SITE)).toBe(false);
  });

  it('still counts an address in that reply as read, not as given by the person', async () => {
    const { provenance } = await recalledInANewChat({
      items: [note({ source: ASSISTANT_RESPONSE_SOURCE, text: REPLY_TEXT, chatReadNothing: true })],
    });

    expect(provenance.untrusted.addresses.has(GUIDE_ADDRESS)).toBe(true);
    expect(provenance.trusted.addresses.has(GUIDE_ADDRESS)).toBe(false);
    expect(provenance.read_from.get(`address:${GUIDE_ADDRESS}`)?.source).toBe('reply');
  });

  it('counts as read when the reply note does not say its chat had read nothing', async () => {
    const { provenance, metadata } = await recalledInANewChat({
      items: [note({ source: ASSISTANT_RESPONSE_SOURCE, text: REPLY_TEXT, chatReadNothing: false })],
    });

    expect(metadata.map(isReplyThatReadNothing)).toEqual([false]);
    expect(hasReadContent(provenance)).toBe(true);
    expect(provenance.untrusted.hosts.has(GUIDE_SITE)).toBe(true);
  });

  it('counts as read after the person edits the note, because the words are no longer the reply', async () => {
    const { provenance, metadata } = await recalledInANewChat({
      items: [note({ source: ASSISTANT_RESPONSE_SOURCE, text: REPLY_TEXT, chatReadNothing: true })],
      edit: `The camping guide moved to ${GUIDE_LINK}new.`,
    });

    expect(metadata.map(isReplyThatReadNothing)).toEqual([false]);
    expect(hasReadContent(provenance)).toBe(true);
  });

  it.each<[string, RetainItem]>([
    [
      'a reply note whose words end with the closing lines',
      note({ source: ASSISTANT_RESPONSE_SOURCE, text: `${REPLY_TEXT}\n\n${MARK_LINES}`, chatReadNothing: false }),
    ],
    [
      'a note from a mail whose words end with the closing lines',
      note({ source: 'email', text: `${REPLY_TEXT}\n\n${MARK_LINES}`, chatReadNothing: true }),
    ],
    [
      'an imported note whose words end with the closing lines',
      {
        content: `${REPLY_TEXT}\n\n${MARK_LINES}`,
        timestamp: SAVED_AT,
        document_id: 'doc-imported',
        metadata: { [MEMORY_ORIGIN_METADATA_KEY]: IMPORTED_ORIGIN },
      },
    ],
    [
      'a note of something read whose words end with the closing lines',
      {
        content: `${REPLY_TEXT}\n\n${MARK_LINES}`,
        timestamp: SAVED_AT,
        document_id: 'doc-read',
        metadata: { [MEMORY_ORIGIN_METADATA_KEY]: 'tool_ingested', reply_read_nothing: 'true' },
      },
    ],
  ])('does not treat %s as such a reply', async (_label, item) => {
    expect(isReplyThatReadNothing(entryMetadata(formatRetainEntry(item)))).toBe(false);

    const { provenance, metadata } = await recalledInANewChat({ items: [item] });
    expect(metadata.map(isReplyThatReadNothing)).toEqual([false]);
    expect(hasReadContent(provenance)).toBe(true);
  });
});
