import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isCallToolResponseResult, type CallToolResponse } from './IMCPServer';

const CONTENT_UNAVAILABLE_CODE = 'github_file_content_unavailable';
const DOWNLOAD_STATUS =
  /(?:successfully\s+downloaded|downloaded\s+successfully)(?:\s+(?:a\s+)?(?:text\s+)?file)?|(?:file|content)\s+(?:was\s+)?downloaded/i;

interface GithubFileContent {
  path: string;
  sha: string;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function requestedPath(params: CallToolRequest['params']): string {
  return isRecord(params.arguments) ? (stringField(params.arguments, 'path') ?? '') : '';
}

function decodeText(payload: Record<string, unknown>): string | undefined {
  const direct = stringField(payload, 'text');
  if (direct !== undefined) {
    return direct;
  }
  const content = stringField(payload, 'content');
  if (content === undefined) {
    return undefined;
  }
  if (stringField(payload, 'encoding') !== 'base64') {
    return content;
  }
  try {
    return Buffer.from(content, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

function findFilePayload(value: unknown, fallbackPath: string, depth = 0): GithubFileContent | undefined {
  if (depth > 4 || !isRecord(value)) {
    return undefined;
  }
  const text = decodeText(value);
  const path = stringField(value, 'path') ?? fallbackPath;
  const sha = stringField(value, 'sha') ?? '';
  if (text !== undefined && path !== '') {
    return { path, sha, text };
  }
  for (const key of ['data', 'file', 'result']) {
    const nested = findFilePayload(value[key], path, depth + 1);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function textBlocks(result: CallToolResult): string[] {
  return result.content.flatMap(block => (block.type === 'text' && block.text ? [block.text] : []));
}

function extractFile(result: CallToolResult, fallbackPath: string): GithubFileContent | undefined {
  const structured = findFilePayload(result.structuredContent, fallbackPath);
  if (structured !== undefined) {
    return structured;
  }
  for (const text of textBlocks(result)) {
    const parsed = parseJson(text);
    const fromJson = findFilePayload(parsed, fallbackPath);
    if (fromJson !== undefined) {
      return fromJson;
    }
    if (!DOWNLOAD_STATUS.test(text) && parsed === undefined && fallbackPath !== '') {
      return { path: fallbackPath, sha: '', text };
    }
  }
  return undefined;
}

function isFileMetadata(value: unknown, depth = 0): boolean {
  if (depth > 4 || !isRecord(value)) {
    return false;
  }
  const type = stringField(value, 'type');
  if (type === 'dir' || type === 'directory') {
    return false;
  }
  if (type === 'file' || (type === undefined && stringField(value, 'sha') !== undefined)) {
    return true;
  }
  return ['data', 'file', 'result'].some(key => isFileMetadata(value[key], depth + 1));
}

function definitelyFileResult(result: CallToolResult): boolean {
  if (isFileMetadata(result.structuredContent)) {
    return true;
  }
  return textBlocks(result).some(text => DOWNLOAD_STATUS.test(text) || isFileMetadata(parseJson(text)));
}

function unavailableResult(path: string): CallToolResult {
  const error = {
    code: CONTENT_UNAVAILABLE_CODE,
    path,
    message:
      'GitHub returned file metadata but no usable file text. The file was not read. Use the checked-out repository in the sandbox; if no checkout exists, propose cloning it once. Do not fetch private repository files through an unauthenticated web tool.',
  };
  return { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true };
}

export function isGithubFileRead(serverName: string, toolName: string): boolean {
  return serverName.toLowerCase() === 'github' && toolName === 'get_file_contents';
}

export function normalizeGithubFileContentsResponse(input: {
  serverName: string;
  params: CallToolRequest['params'];
  response: CallToolResponse;
}): CallToolResponse {
  if (!isGithubFileRead(input.serverName, input.params.name) || !isCallToolResponseResult(input.response)) {
    return input.response;
  }
  const { result } = input.response;
  if (result.isError) {
    return input.response;
  }
  const path = requestedPath(input.params);
  const file = extractFile(result, path);
  if (file !== undefined) {
    return {
      ...input.response,
      result: {
        content: [{ type: 'text', text: JSON.stringify(file) }],
        structuredContent: { path: file.path, sha: file.sha, text: file.text },
      },
    };
  }
  return definitelyFileResult(result) ? { ...input.response, result: unavailableResult(path) } : input.response;
}

export function isGithubFileContentUnavailable(response: CallToolResponse): boolean {
  return (
    isCallToolResponseResult(response) &&
    response.result.isError === true &&
    textBlocks(response.result).some(text => text.includes(CONTENT_UNAVAILABLE_CODE))
  );
}
