import type {
  AgentExecutionTrace,
  AgentLocalToolTrace,
  AgentRemoteMcpToolTrace,
  AgentTracing,
  CallToolResponse,
} from '@truefoundry/trueforge-core/core';
import { createWebSearchTurnState, pageImageUrls, type WebSearchTurnState } from '@truefoundry/trueforge-core/core';
import { recordPageImageUrls, recordSearchResults } from '@truefoundry/trueforge-core/core/permissions/provenance';
import {
  CREATE_SPACE_TOOL_NAME,
  EDIT_SPACE_TOOL_NAME,
  GET_SPACE_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/spaces/toolContract';
import type { SpaceRecord } from '../../../src/db/spaceStore';
import { spaceCapability, type SpaceToolStore } from '../../../src/runtime/spaceCapability';
import { SPACE_PICTURE_DATA_MAX_CHARS } from '../../../src/runtime/spaceLinks';
import { isRecord } from '../../fixtures/jsonGuards';

const NOOP_EXECUTION_TRACE: AgentExecutionTrace = {
  runInContext: operation => operation(),
  startSubAgent: () => NOOP_EXECUTION_TRACE,
  setOutput: () => undefined,
  setMetrics: () => undefined,
  setError: () => undefined,
  setSuccess: () => undefined,
  end: () => undefined,
};
const NOOP_LOCAL_TOOL_TRACE: AgentLocalToolTrace = { setOutput: () => undefined, setSandboxId: () => undefined };
const NOOP_REMOTE_MCP_TOOL_TRACE: AgentRemoteMcpToolTrace = {
  setOutput: () => undefined,
  setNumberOfTools: () => undefined,
};
const NOOP_TRACING: AgentTracing = {
  withInitSpan: operation => operation(),
  startRootSpan: () => NOOP_EXECUTION_TRACE,
  withLocalToolSpan: (_input, operation) => operation(NOOP_LOCAL_TOOL_TRACE),
  withRemoteMcpToolSpan: (_input, operation) => operation(NOOP_REMOTE_MCP_TOOL_TRACE),
};

const AUTHORITY = { tenantId: 'default', userRef: 'user-a' };

const COLLIE_URL = 'https://upload.wikimedia.org/wikipedia/commons/1/1a/Border_Collie_working.jpg';
const POODLE_URL = 'https://upload.wikimedia.org/wikipedia/commons/2/2b/Standard_Poodle.jpg';

const NOT_SEEN_PICTURE = "Open the picture's page first, then use the image link from that page.";

function textOf(response: CallToolResponse): string {
  if (!('result' in response)) {
    throw new Error('expected a space tool result');
  }
  const content = response.result.content[0];
  return content?.type === 'text' ? content.text : '';
}

/** Guards for tool-result JSON, so the tests never lean on an assertion escape. */
function parsedObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error('expected a JSON object');
  }
  return parsed;
}

function fieldObject(owner: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = owner[field];
  if (!isRecord(value)) {
    throw new Error(`expected an object ${field}`);
  }
  return value;
}

function stringField(owner: Record<string, unknown>, field: string): string {
  const value = owner[field];
  if (typeof value !== 'string') {
    throw new Error(`expected a string ${field}`);
  }
  return value;
}

function makeStore(): SpaceToolStore {
  const rows = new Map<string, SpaceRecord>();
  let aggregate = 0;
  const save = (record: SpaceRecord) => {
    rows.set(record.id, record);
    aggregate += 1;
    return { record, aggregate_revision: aggregate };
  };
  return {
    createSpace: async input =>
      save({
        tenant_id: AUTHORITY.tenantId,
        created_by: AUTHORITY.userRef,
        id: input.id,
        name: input.name,
        purpose: input.purpose,
        status: input.status,
        body: input.body,
        format: input.format,
        revision: 1,
        created_at: '2026-10-21T00:00:00.000Z',
        updated_at: '2026-10-21T00:00:00.000Z',
      }),
    updateSpace: async input => {
      const current = rows.get(input.space_id);
      if (current === undefined) {
        throw new Error(`no space ${input.space_id}`);
      }
      return save({
        ...current,
        name: input.name,
        purpose: input.purpose,
        status: input.status,
        body: input.body,
        format: input.format,
        revision: current.revision + 1,
      });
    },
    revertSpace: async () => {
      throw new Error('not used in these tests');
    },
    getSpace: async input => rows.get(input.space_id),
    getSpaceRevision: async () => undefined,
    listSpacesWithAggregate: async () => ({
      records: [...rows.values()],
      aggregate_revision: aggregate,
      has_more: false,
      next_offset: null,
    }),
  };
}

/** A search result as the designated provider returns it: each result's own `url` is what counts. */
function searchResult(urls: string[]): string {
  return JSON.stringify({ results: urls.map((url, index) => ({ title: `Result ${String(index + 1)}`, url })) });
}

function setup(webSearch: WebSearchTurnState, store: SpaceToolStore = makeStore()) {
  const capability = spaceCapability({ store, authority: AUTHORITY, tracing: NOOP_TRACING, webSearch });
  const toolSet = capability.systemToolSets?.[0];
  if (toolSet === undefined) {
    throw new Error('expected space tool set');
  }
  return (name: string, args: Record<string, unknown>) => toolSet.callTool({ name, arguments: args });
}

function createArgs(body: string) {
  return { name: 'Dog breeds', purpose: 'Dog breeds with pictures.', status: 'active', format: 'markdown', body };
}

/** The fingerprint the get_space outline shows for one anchor, read the way a model reads it. */
async function fingerprintOf(
  call: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
  input: { spaceName: string; anchor: string },
): Promise<string> {
  const read = parsedObject(textOf(await call(GET_SPACE_TOOL_NAME, { space_name: input.spaceName })));
  const blocks = read['blocks'];
  if (!Array.isArray(blocks)) {
    throw new Error('expected a blocks list in the get_space result');
  }
  for (const block of blocks) {
    if (isRecord(block) && block['anchor'] === input.anchor) {
      return stringField(block, 'fingerprint');
    }
  }
  throw new Error(`expected block ${input.anchor} in the get_space result for ${input.spaceName}`);
}

function isErrorResponse(response: CallToolResponse): boolean {
  return 'result' in response && response.result.isError === true;
}

async function errorOf(response: CallToolResponse): Promise<string> {
  const parsed = parsedObject(textOf(response));
  const error = parsed['error'];
  return typeof error === 'string' ? error : '';
}

describe('space pictures and links come only from this chat', () => {
  it('refuses a picture link the chat never returned, with the message the model acts on', async () => {
    const call = setup(createWebSearchTurnState());
    const response = await call(CREATE_SPACE_TOOL_NAME, {
      ...createArgs(`![Collie](https://images.wikimedia.org/invented/border-collie.jpg)`),
    });
    expect(await errorOf(response)).toBe("Open the picture's page first, then use the image link from that page.");
  });

  it('refuses a placeholder domain even when a search result returned it', async () => {
    const webSearch = createWebSearchTurnState();
    recordSearchResults({
      provenance: webSearch.provenance,
      texts: [searchResult(['https://example.com/collie.jpg'])],
    });
    const call = setup(webSearch);
    const response = await call(CREATE_SPACE_TOOL_NAME, {
      ...createArgs('<img src="https://example.com/collie.jpg" alt="Collie">'),
    });
    expect(await errorOf(response)).toContain('placeholder domain');
    const sub = await call(CREATE_SPACE_TOOL_NAME, {
      ...createArgs('<img src="https://cdn.example.org/collie.jpg" alt="Collie">'),
    });
    expect(await errorOf(sub)).toContain('placeholder domain');
  });

  it('keeps a picture link that a search result returned, exactly as returned', async () => {
    const webSearch = createWebSearchTurnState();
    recordSearchResults({ provenance: webSearch.provenance, texts: [searchResult([COLLIE_URL])] });
    const call = setup(webSearch);
    const created = fieldObject(
      parsedObject(
        textOf(await call(CREATE_SPACE_TOOL_NAME, { ...createArgs(`<img src="${COLLIE_URL}" alt="Collie">`) })),
      ),
      'space',
    );
    expect(stringField(created, 'body')).toContain(COLLIE_URL);
  });

  it('refuses a seen link with query data appended, since that is a different address', async () => {
    const webSearch = createWebSearchTurnState();
    recordSearchResults({ provenance: webSearch.provenance, texts: [searchResult([COLLIE_URL])] });
    const call = setup(webSearch);
    const response = await call(CREATE_SPACE_TOOL_NAME, {
      ...createArgs(`<img src="${COLLIE_URL}?email=person%40example.org" alt="Collie">`),
    });
    expect(await errorOf(response)).toBe(NOT_SEEN_PICTURE);
  });

  it('refuses a picture link copied from an email body, since mail text is not a result URL', async () => {
    const webSearch = createWebSearchTurnState();
    // The model read this mail: the link is in the body text and in the Gmail tool's linked_images list.
    // Neither is a result's own `url` field, so neither is recorded.
    const mail = JSON.stringify({
      bodyHtml: `<img src="${POODLE_URL}">`,
      linked_images: [POODLE_URL],
    });
    recordSearchResults({ provenance: webSearch.provenance, texts: [mail] });
    const call = setup(webSearch);
    const response = await call(CREATE_SPACE_TOOL_NAME, { ...createArgs(`<img src="${POODLE_URL}" alt="Poodle">`) });
    expect(await errorOf(response)).toBe(NOT_SEEN_PICTURE);
  });

  it('refuses an http picture even when a result returned it', async () => {
    const webSearch = createWebSearchTurnState();
    const plain = COLLIE_URL.replace('https://', 'http://');
    recordSearchResults({ provenance: webSearch.provenance, texts: [searchResult([plain])] });
    const call = setup(webSearch);
    const response = await call(CREATE_SPACE_TOOL_NAME, { ...createArgs(`<img src="${plain}" alt="Collie">`) });
    expect(await errorOf(response)).toContain('must use a secure https link');
  });

  it('refuses a data: picture over the size cap and keeps one under it', async () => {
    const call = setup(createWebSearchTurnState());
    const pad = 'A'.repeat(SPACE_PICTURE_DATA_MAX_CHARS);
    const tooLarge = await call(CREATE_SPACE_TOOL_NAME, {
      ...createArgs(`<img src="data:image/png;base64,${pad}" alt="Big">`),
    });
    expect(await errorOf(tooLarge)).toContain('too large');
    const small = fieldObject(
      parsedObject(
        textOf(
          await call(CREATE_SPACE_TOOL_NAME, {
            ...createArgs('<img src="data:image/png;base64,AAAA" alt="Dot">'),
          }),
        ),
      ),
      'space',
    );
    expect(stringField(small, 'body')).toContain('data:image/png;base64,AAAA');
  });

  it('checks only links a write adds, so an unrelated block edit keeps a picture from an earlier turn', async () => {
    const store = makeStore();
    // Turn one: the search ran, and the skeleton used its picture.
    const turnOne = createWebSearchTurnState();
    recordSearchResults({ provenance: turnOne.provenance, texts: [searchResult([COLLIE_URL])] });
    const createdResponse = await setup(turnOne, store)(CREATE_SPACE_TOOL_NAME, {
      ...createArgs(
        ['# Dog breeds', '<!-- @block:one -->', `![Collie](${COLLIE_URL})`, '<!-- @block:two -->', '(to fill)'].join(
          '\n',
        ),
      ),
    });
    expect(isErrorResponse(createdResponse)).toBe(false);
    // Turn two: no search ran, so the old picture is not in this turn's results. A text edit still goes through.
    const turnTwo = setup(createWebSearchTurnState(), store);
    const updated = await turnTwo(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Dog breeds',
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'two',
          fingerprint: await fingerprintOf(turnTwo, { spaceName: 'Dog breeds', anchor: 'two' }),
          new_content: 'Border Collie, rank 1.',
        },
      ],
    });
    expect(textOf(updated)).toContain('Updated space \\"Dog breeds\\"');
  });

  it('refuses a block edit that adds an invented picture to a space', async () => {
    const webSearch = createWebSearchTurnState();
    const call = setup(webSearch);
    const createdResponse = await call(CREATE_SPACE_TOOL_NAME, {
      ...createArgs('# Dog breeds\n<!-- @block:one -->\n(to fill)'),
    });
    expect(isErrorResponse(createdResponse)).toBe(false);
    const response = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Dog breeds',
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'one',
          fingerprint: await fingerprintOf(call, { spaceName: 'Dog breeds', anchor: 'one' }),
          new_content: '![Collie](https://cdn.example.net/collie.jpg)',
        },
      ],
    });
    expect(await errorOf(response)).toContain('placeholder domain');
  });
});

describe('scripted run: dog breeds with pictures', () => {
  it('searches for pictures, then builds the space from the result URLs only', async () => {
    const webSearch = createWebSearchTurnState();
    const call = setup(webSearch);

    // Step 1: the search. The host records each result's own url, as the designated provider returns it.
    recordSearchResults({ provenance: webSearch.provenance, texts: [searchResult([COLLIE_URL, POODLE_URL])] });

    // Step 2: the skeleton, with the pictures from the search results.
    const created = parsedObject(
      textOf(
        await call(CREATE_SPACE_TOOL_NAME, {
          name: 'Dog breeds',
          purpose: 'Top dog breeds with pictures.',
          status: 'active',
          format: 'html',
          body: [
            '<div class="page-header"><h1>Dog breeds</h1></div>',
            '<!-- @block:collie -->',
            `<div class="card"><img src="${COLLIE_URL}" alt="Border Collie" width="160"><h3>Border Collie</h3></div>`,
            '<!-- @block:poodle -->',
            `<div class="card"><img src="${POODLE_URL}" alt="Poodle" width="160"><h3>Poodle</h3></div>`,
          ].join('\n'),
        }),
      ),
    );
    const createdSpace = fieldObject(created, 'space');
    expect(stringField(created, 'summary')).toBe('Created space "Dog breeds" (revision 1).');
    expect(stringField(createdSpace, 'link')).toMatch(/^\/spaces\/[^/]+$/);
    expect('id' in createdSpace).toBe(false);
    expect(stringField(createdSpace, 'body')).toContain(COLLIE_URL);
    expect(stringField(createdSpace, 'body')).toContain(POODLE_URL);

    // Step 3: read it back by name, the way a model addresses a space now.
    const read = fieldObject(
      parsedObject(textOf(await call(GET_SPACE_TOOL_NAME, { space_name: 'Dog breeds' }))),
      'space',
    );
    expect(stringField(read, 'body')).not.toContain('example.');
    expect(stringField(read, 'body')).toContain(`src="${POODLE_URL}"`);
  });
});

describe('page reads, scripts, and empty bodies', () => {
  it('lets a space use a picture from a Commons page the chat opened, though no result named the file', async () => {
    const webSearch = createWebSearchTurnState();
    // The search returned the Commons File: page, not the image file link.
    recordSearchResults({
      provenance: webSearch.provenance,
      texts: [searchResult(['https://commons.wikimedia.org/wiki/File:Border_Collie_working.jpg'])],
    });
    // The page read returned the page, whose own picture is the upload.wikimedia.org file.
    recordPageImageUrls({
      provenance: webSearch.provenance,
      urls: pageImageUrls(`# File:Border Collie working.jpg\n<img src="${COLLIE_URL}" alt="Border Collie working">`),
    });
    const call = setup(webSearch);
    const created = fieldObject(
      parsedObject(
        textOf(
          await call(CREATE_SPACE_TOOL_NAME, {
            ...createArgs(`<img src="${COLLIE_URL}" alt="Border Collie">`),
          }),
        ),
      ),
      'space',
    );
    expect(stringField(created, 'body')).toContain(COLLIE_URL);
  });

  it('refuses an external script source with the scripts-never-run guidance', async () => {
    const call = setup(createWebSearchTurnState());
    const response = await call(CREATE_SPACE_TOOL_NAME, {
      ...createArgs('<script src="https://cdn.example.net/carousel.js"></script><p>Breeds</p>'),
    });
    expect(await errorOf(response)).toBe('Scripts never run on a space page. Use plain HTML and CSS instead.');
  });

  it('refuses an empty create body instead of saving an empty space', async () => {
    const call = setup(createWebSearchTurnState());
    for (const body of ['', '   ']) {
      const response = await call(CREATE_SPACE_TOOL_NAME, { ...createArgs(body) });
      expect(await errorOf(response)).toContain('The space body is empty');
      expect(isErrorResponse(response)).toBe(true);
    }
  });

  it('refuses an array body, since the contract takes one string body only', async () => {
    const call = setup(createWebSearchTurnState());
    const response = await call(CREATE_SPACE_TOOL_NAME, {
      name: 'Dog breeds',
      purpose: 'Dog breeds with pictures.',
      status: 'active',
      format: 'markdown',
      body: ['# Dog breeds', 'A line.'],
    });
    expect(isErrorResponse(response)).toBe(true);
    const error = await errorOf(response);
    expect(error).toContain('Invalid space call');
    expect(error).toContain('body');
    expect(error).toContain('Fix the listed fields and send the call again.');
  });

  it('refuses an edit that empties the body instead of wiping the space', async () => {
    const store = makeStore();
    const call = setup(createWebSearchTurnState(), store);
    const createdResponse = await call(CREATE_SPACE_TOOL_NAME, { ...createArgs('# Dog breeds\nSome content here.') });
    expect(isErrorResponse(createdResponse)).toBe(false);
    // The body is the heading (b1) and one line (b2): deleting both is the wipe the
    // empty-body refusal exists to stop.
    const response = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Dog breeds',
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: await fingerprintOf(call, { spaceName: 'Dog breeds', anchor: 'b1' }),
          new_content: '',
        },
        {
          type: 'block',
          anchor: 'b2',
          fingerprint: await fingerprintOf(call, { spaceName: 'Dog breeds', anchor: 'b2' }),
          new_content: '',
        },
      ],
    });
    expect(await errorOf(response)).toContain('The space body is empty');
    const read = fieldObject(
      parsedObject(textOf(await call(GET_SPACE_TOOL_NAME, { space_name: 'Dog breeds' }))),
      'space',
    );
    expect(stringField(read, 'body')).toBe('# Dog breeds\nSome content here.');
  });

  it('names the bad field on an invalid space call instead of a bare validation failure', async () => {
    const call = setup(createWebSearchTurnState());
    const response = await call(CREATE_SPACE_TOOL_NAME, {
      name: 'Dog breeds',
      purpose: 'Dog breeds with pictures.',
      status: 'active',
      format: 'markdown',
    });
    const error = await errorOf(response);
    expect(error).toContain('Invalid space call');
    expect(error).toContain('body');
    expect(error).toContain('Fix the listed fields and send the call again.');
    expect(error).not.toBe('Validation failed');
  });

  it('keeps the content of a create with content', async () => {
    const call = setup(createWebSearchTurnState());
    const body = '# Dog breeds\nA short note.';
    const created = fieldObject(
      parsedObject(textOf(await call(CREATE_SPACE_TOOL_NAME, { ...createArgs(body) }))),
      'space',
    );
    expect(stringField(created, 'body')).toBe(body);
  });
});
