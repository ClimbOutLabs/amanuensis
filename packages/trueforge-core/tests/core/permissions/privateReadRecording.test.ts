import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import {
  createSentinelHostContext,
  defaultSentinelServices,
  toDispatchSentinelContext,
} from '../../../src/core/permissions/context';
import {
  createWebSearchTurnState,
  keepSubAgentAnswerText,
  recordPrivateToolResult,
  SEARCH_AFTER_READ_SILENT_REASON,
  type WebSearchTurnState,
} from '../../../src/core/permissions/webSearch';

const MAIL_ATTACHMENT_TEXT = 'Invoice 4471 is due to Harbour Clinic on Friday, paid by bank transfer only.';

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function makeCtx(web_search: WebSearchTurnState = createWebSearchTurnState()): ClassifyContext {
  return {
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search,
  };
}

function searchFor(query: string): SentinelAction {
  return {
    tool_name: 'web_search',
    canonical_params: { query },
    tool_type: 'mcp',
    mcp_server_name: 'search',
    mcp_search_provider: true,
    mcp_search_tool: true,
    mcp_hints: { read_only_hint: true, open_world_hint: true },
  };
}

const COPIED_QUERY = 'is due to Harbour Clinic on Friday';

describe('private reads recorded from tool results', () => {
  it('holds a search that copies text from a mail attachment read through the document tool', () => {
    const turn = createWebSearchTurnState();
    recordPrivateToolResult({
      state: turn,
      tool_name: 'download_attachment',
      result: textResult('Saved the attachment to the sandbox at /workspace/mail/invoice.txt'),
    });
    recordPrivateToolResult({
      state: turn,
      tool_name: 'extract_document_text',
      result: textResult(MAIL_ATTACHMENT_TEXT),
    });
    return expect(classifyTier(searchFor(COPIED_QUERY), makeCtx(turn))).resolves.toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });

  it('still runs a search whose text is unrelated to the attachment', async () => {
    const turn = createWebSearchTurnState();
    recordPrivateToolResult({
      state: turn,
      tool_name: 'extract_document_text',
      result: textResult(MAIL_ATTACHMENT_TEXT),
    });
    expect(await classifyTier(searchFor('best tapas in Lisbon'), makeCtx(turn))).toMatchObject({
      tier: 1,
      reason: SEARCH_AFTER_READ_SILENT_REASON,
    });
  });

  it('holds every later search when a private read cannot be recorded', async () => {
    const turn = createWebSearchTurnState();
    recordPrivateToolResult({
      state: turn,
      tool_name: 'read_email',
      result: { isError: true, content: [{ type: 'text', text: 'quota exceeded' }] },
    });
    expect(await classifyTier(searchFor('best tapas in Lisbon'), makeCtx(turn))).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });

  it('holds a search after a sub-agent read the attachment, because every thread shares the turn state', async () => {
    const turn = createWebSearchTurnState();
    const host = createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'c1',
      web_search: turn,
    });
    const subAgentDispatch = toDispatchSentinelContext(host);
    if (subAgentDispatch === undefined) {
      throw new Error('expected a dispatch context');
    }
    recordPrivateToolResult({
      state: subAgentDispatch.web_search,
      tool_name: 'extract_document_text',
      result: textResult(MAIL_ATTACHMENT_TEXT),
    });
    expect(await classifyTier(searchFor(COPIED_QUERY), makeCtx(turn))).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });

  it('does not record a result from a tool that does not read private data', async () => {
    const turn = createWebSearchTurnState();
    recordPrivateToolResult({
      state: turn,
      tool_name: 'web_search',
      result: textResult(MAIL_ATTACHMENT_TEXT),
    });
    expect(await classifyTier(searchFor(COPIED_QUERY), makeCtx(turn))).toMatchObject({ tier: 1 });
  });

  it('catches a copied phrase whose words are split by line breaks or extra spaces in the private text', async () => {
    const turn = createWebSearchTurnState();
    recordPrivateToolResult({
      state: turn,
      tool_name: 'extract_document_text',
      result: textResult('Invoice 4471 is due\nto   Harbour\n\nClinic on Friday, paid by bank transfer only.'),
    });
    expect(await classifyTier(searchFor(COPIED_QUERY), makeCtx(turn))).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
    expect(await classifyTier(searchFor('is due\nto Harbour Clinic\non Friday'), makeCtx(turn))).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });

  it('holds a search that copies a sub-agent answer built from mail', async () => {
    const turn = createWebSearchTurnState();
    recordPrivateToolResult({
      state: turn,
      tool_name: 'read_email',
      result: textResult('Mail read'),
    });
    keepSubAgentAnswerText({ state: turn, text: `Summary: ${MAIL_ATTACHMENT_TEXT}` });
    expect(await classifyTier(searchFor(COPIED_QUERY), makeCtx(turn))).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });

  it('holds every later search after an unscannable read, whatever else the turn kept', async () => {
    const turn = createWebSearchTurnState();
    keepSubAgentAnswerText({ state: turn, text: `Summary: ${MAIL_ATTACHMENT_TEXT}` });
    recordPrivateToolResult({
      state: turn,
      tool_name: 'read_email',
      result: { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
    });
    expect(await classifyTier(searchFor('best tapas in Lisbon'), makeCtx(turn))).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });

  it('holds a search that copies what a later command printed after a mail read', async () => {
    const turn = createWebSearchTurnState();
    recordPrivateToolResult({ state: turn, tool_name: 'download_attachment', result: textResult('Saved invoice.txt') });
    recordPrivateToolResult({ state: turn, tool_name: 'exec', result: textResult(MAIL_ATTACHMENT_TEXT) });
    expect(await classifyTier(searchFor(COPIED_QUERY), makeCtx(turn))).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });

  it('does not keep results of other tools from before the turn read private data', async () => {
    const turn = createWebSearchTurnState();
    recordPrivateToolResult({ state: turn, tool_name: 'exec', result: textResult(MAIL_ATTACHMENT_TEXT) });
    expect(await classifyTier(searchFor(COPIED_QUERY), makeCtx(turn))).toMatchObject({ tier: 1 });
  });

  it('holds later searches when a result from another tool cannot be scanned after a mail read', async () => {
    const turn = createWebSearchTurnState();
    recordPrivateToolResult({ state: turn, tool_name: 'read_email', result: textResult('Mail read') });
    recordPrivateToolResult({
      state: turn,
      tool_name: 'screenshot',
      result: { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
    });
    expect(await classifyTier(searchFor('best tapas in Lisbon'), makeCtx(turn))).toMatchObject({
      tier: 3,
      reason: 'mcp_search_after_private_read',
    });
  });
});
