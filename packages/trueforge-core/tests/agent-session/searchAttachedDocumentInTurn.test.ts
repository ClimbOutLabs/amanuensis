/**
 * A PDF the person attaches is read by the real upload path: staged into the sandbox and extracted before the model
 * runs. When extraction stops before the end of the file, the chat cannot vouch for what the rest says, so a search
 * that carries a detail from an unread page asks first.
 */
import { EventType } from '../../src/agent-session/schemas/events';
import { HOLD_SAY } from '../../src/core/permissions/searchHoldText';
import { MAX_PAGES_PER_DOCUMENT } from '../../src/documents/documentExtraction';
import { syntheticBytesFor } from '../core/documents/syntheticFiles';
import '../core/harnessMocks';
import { makeStubPublicSandbox } from '../core/harnessMocks';
import { searchStream, setupSearchChat, textStream } from './searchTurnHarness';

/** Invented details only. */
const NAME_PAGE = 120;
const NAME = 'Ottilie Vanbrugh-Carrow';

/** A sandbox whose PDF reader returns pages of a document `total` pages long, with the name on one page. */
function sandboxWithDocument({ total, name_page }: { total: number; name_page: number }) {
  const sandbox = makeStubPublicSandbox();
  jest
    .spyOn(sandbox, 'uploadUserFile')
    .mockImplementation(input => Promise.resolve({ filePath: `/tmp/uploads/${input.fileName}` }));
  jest.spyOn(sandbox, 'createDocumentSnapshot').mockImplementation(input =>
    Promise.resolve({
      filePath: input.filePath,
      content: syntheticBytesFor(input.filePath),
      verify: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    }),
  );
  jest.spyOn(sandbox, 'runDocumentText').mockImplementation(input => {
    const first = input.firstPage ?? 1;
    const last = Math.min(total, first + input.maxPages - 1);
    const pages = [];
    for (let page = first; page <= last; page += 1) {
      pages.push({
        page_number: page,
        text: page === name_page ? `Tenant: ${NAME}.` : `Clause ${String(page)} of the lease.`,
      });
    }
    return Promise.resolve({ total_pages: total, pages });
  });
  return sandbox;
}

const pdf = `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`;

async function attachAndSearch(document: { total: number; name_page: number }) {
  const chat = await setupSearchChat({ sandbox: sandboxWithDocument(document) });
  chat.create.mockImplementationOnce(() => searchStream({ id: 'call-1', query: `${NAME} lease` }));
  chat.create.mockImplementation(() => textStream('Done.'));
  const turn = await chat.run({
    messages: [
      {
        type: EventType.USER_MESSAGE,
        content: [
          { type: 'text', text: 'Who is the tenant?' },
          { type: 'file', name: 'lease.pdf', data: pdf },
        ],
      },
    ],
  });
  return { ...chat, state: (await chat.session.getTurn(turn.id))?.state };
}

describe('a PDF attached through the upload path', () => {
  it('asks before a search when extraction stopped before the page that names the person', async () => {
    expect(NAME_PAGE).toBeGreaterThan(MAX_PAGES_PER_DOCUMENT);
    const { state, callTool } = await attachAndSearch({ total: 150, name_page: NAME_PAGE });

    expect(state).toMatchObject({ status: 'done', required_actions: [{ type: EventType.TOOL_APPROVAL_REQUIRED }] });
    expect(JSON.stringify(state)).toContain(HOLD_SAY.private_unchecked);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('holds a search for a name from a fully read PDF, as a detail from the file', async () => {
    const { state, callTool } = await attachAndSearch({ total: 90, name_page: 60 });

    expect(JSON.stringify(state)).toContain(HOLD_SAY.private_detail);
    expect(callTool).not.toHaveBeenCalled();
  });
});
