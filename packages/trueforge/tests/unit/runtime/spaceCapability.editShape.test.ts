import type { AgentTracing } from '@truefoundry/trueforge-core/core';
import { createWebSearchTurnState } from '@truefoundry/trueforge-core/core';
import {
  checkToolArguments,
  toolArgumentProblemMessage,
  toParameterSchema,
} from '@truefoundry/trueforge-core/core/mcp/toolArgumentCheck';
import { EDIT_SPACE_TOOL_NAME } from '@truefoundry/trueforge-core/core/spaces/toolContract';
import { spaceCapability, type SpaceToolStore } from '../../../src/runtime/spaceCapability';

const NOOP_TRACING: AgentTracing = {
  withInitSpan: operation => operation(),
  startRootSpan: () => {
    throw new Error('not used in this test');
  },
  withLocalToolSpan: () => {
    throw new Error('not used in this test');
  },
  withRemoteMcpToolSpan: () => {
    throw new Error('not used in this test');
  },
};

const UNUSED_STORE: SpaceToolStore = {
  createSpace: () => Promise.reject(new Error('not used in this test')),
  updateSpace: () => Promise.reject(new Error('not used in this test')),
  revertSpace: () => Promise.reject(new Error('not used in this test')),
  listSpacesWithAggregate: () => Promise.reject(new Error('not used in this test')),
  getSpace: () => Promise.reject(new Error('not used in this test')),
  getSpaceRevision: () => Promise.reject(new Error('not used in this test')),
};

async function editSpaceSchema() {
  const capability = spaceCapability({
    store: UNUSED_STORE,
    authority: { tenantId: 'default', userRef: 'user-a' },
    tracing: NOOP_TRACING,
    webSearch: createWebSearchTurnState(),
  });
  const toolSet = capability.systemToolSets?.[0];
  if (toolSet === undefined) {
    throw new Error('expected the space tool set');
  }
  const listed = await toolSet.listTools();
  if (!('result' in listed)) {
    throw new Error('expected a tool list');
  }
  const tool = listed.result.tools.find(candidate => candidate.name === EDIT_SPACE_TOOL_NAME);
  if (tool === undefined) {
    throw new Error('expected the edit tool');
  }
  return toParameterSchema(tool.inputSchema);
}

describe('the edit tool when an edit entry has the wrong shape', () => {
  it('tells the model what each kind of entry needs, from the tool schema itself', async () => {
    const schema = await editSpaceSchema();
    const outcome = checkToolArguments({
      schema,
      args: { space_name: 'Lantern Workshop Notes', edits: [{ find: 'Lanterns', with: 'Candles' }] },
      readOnly: false,
    });
    const message = toolArgumentProblemMessage({ toolName: EDIT_SPACE_TOOL_NAME, problems: outcome.problems });

    expect(message).toContain(
      'edits[0] must be either an object with type set to "block", anchor (text), fingerprint (text) and new_content (text)',
    );
    expect(message).toContain(
      'an object with type set to "insert", after (text), fingerprint (text) and new_content (text)',
    );
    expect(message).toContain('or an object with type set to "append" and new_content (text)');
    expect(message).not.toContain('named fields');
  });

  it('points at the one missing field when the entry names its own kind', async () => {
    const schema = await editSpaceSchema();
    const outcome = checkToolArguments({
      schema,
      args: {
        space_name: 'Lantern Workshop Notes',
        expected_revision: 1,
        edits: [{ type: 'block', anchor: 'intro', fingerprint: '0123abcd' }],
      },
      readOnly: false,
    });
    expect(outcome.problems.map(problem => problem.path)).toEqual(['edits[0].new_content']);
  });

  it('accepts edits sent as the JSON text of a list, and still refuses text that is not a list', async () => {
    const schema = await editSpaceSchema();
    const edits = [{ type: 'append', new_content: 'More notes.' }];
    const accepted = checkToolArguments({
      schema,
      args: { space_name: 'Lantern Workshop Notes', expected_revision: 1, edits: JSON.stringify(edits) },
      readOnly: false,
    });
    expect(accepted.problems).toEqual([]);
    expect(accepted.args['edits']).toEqual(edits);

    const refused = checkToolArguments({
      schema,
      args: { space_name: 'Lantern Workshop Notes', expected_revision: 1, edits: 'append More notes.' },
      readOnly: false,
    });
    expect(refused.problems.map(problem => problem.path)).toEqual(['edits']);
  });
});
