import type { CallToolResponse } from '../../../src/core/mcp/IMCPServer';
import { normalizeGithubFileContentsResponse } from '../../../src/core/mcp/githubFileContents';

function responseWithText(text: string): CallToolResponse {
  return {
    result: { content: [{ type: 'text', text }] },
    wasInitialized: undefined,
    verificationReceiptCandidate: undefined,
  };
}

describe('GitHub file content normalization', () => {
  it('normalizes a base64 GitHub file into path, sha, and text', () => {
    const response = normalizeGithubFileContentsResponse({
      serverName: 'github',
      params: { name: 'get_file_contents', arguments: { path: 'package.json' } },
      response: responseWithText(
        JSON.stringify({
          type: 'file',
          path: 'package.json',
          sha: 'abc123',
          encoding: 'base64',
          content: Buffer.from('{"name":"fixture"}').toString('base64'),
        }),
      ),
    });

    expect(response).toMatchObject({
      result: {
        structuredContent: { path: 'package.json', sha: 'abc123', text: '{"name":"fixture"}' },
      },
    });
  });

  it('turns metadata-only success into an explicit failed read', () => {
    const response = normalizeGithubFileContentsResponse({
      serverName: 'github',
      params: { name: 'get_file_contents', arguments: { path: 'pnpm-workspace.yaml' } },
      response: responseWithText('successfully downloaded text file (SHA: deadbeef)'),
    });

    expect(response).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(response)).toContain('github_file_content_unavailable');
    expect(JSON.stringify(response)).toContain('The file was not read');
  });

  it('rejects alternate contentless success prose', () => {
    const response = normalizeGithubFileContentsResponse({
      serverName: 'github',
      params: { name: 'get_file_contents', arguments: { path: 'package.json' } },
      response: responseWithText('File downloaded successfully (SHA: deadbeef)'),
    });
    expect(response).toMatchObject({ result: { isError: true } });
  });

  it('rejects JSON file metadata that omits the content field', () => {
    const response = normalizeGithubFileContentsResponse({
      serverName: 'github',
      params: { name: 'get_file_contents', arguments: { path: 'package.json' } },
      response: responseWithText(JSON.stringify({ type: 'file', path: 'package.json', sha: 'abc123' })),
    });
    expect(response).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(response)).toContain('github_file_content_unavailable');
  });

  it('leaves directory listings unchanged', () => {
    const original = responseWithText(JSON.stringify([{ type: 'dir', path: 'packages' }]));
    expect(
      normalizeGithubFileContentsResponse({
        serverName: 'github',
        params: { name: 'get_file_contents', arguments: { path: '' } },
        response: original,
      }),
    ).toBe(original);
  });

  it('does not treat directory metadata with a sha as a contentless file', () => {
    const original = responseWithText(JSON.stringify({ type: 'dir', path: 'packages', sha: 'tree-sha' }));
    expect(
      normalizeGithubFileContentsResponse({
        serverName: 'github',
        params: { name: 'get_file_contents', arguments: { path: 'packages' } },
        response: original,
      }),
    ).toBe(original);
  });
});
