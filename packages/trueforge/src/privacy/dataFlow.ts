/**
 * The data-flow manifest: every external connection this system can make.
 * Single source of truth for the `GET /api/v1/privacy/data-flow` endpoint,
 * the Settings > Privacy data-flow viewer, and `docs/privacy-data-flow.mdx`.
 * Keep all three in sync when this list changes.
 */
import type { DataFlowConnection, DataFlowManifest } from '../schemas/privacy';

export const DATA_FLOW_MANIFEST_VERSION = '1';

const CONNECTIONS: DataFlowConnection[] = [
  {
    id: 'model-provider',
    category: 'Model API',
    destination: 'The configured model provider base URL (a cloud API such as OpenAI or Anthropic, or a self-hosted endpoint)',
    data_sent: 'Prompts, conversation history, tool definitions, and tool results for each turn',
    purpose: 'Generate the assistant responses. The model only sees what the current turn sends it.',
    how_to_disable: 'Point the model provider at a local endpoint (for example Ollama or vLLM on localhost), or turn on offline mode to block all non-local calls.',
  },
  {
    id: 'embedding-model-download',
    category: 'Model download',
    destination: 'huggingface.co (the model hub)',
    data_sent: 'Nothing is uploaded. Only the requested model id is sent, to download the file.',
    purpose: 'One-time download of the local embedding model used for memory retrieval.',
    how_to_disable: 'Pre-seed the embedding model directory before first run, or turn on offline mode. Memory retrieval falls back to keyword search without the model.',
  },
  {
    id: 'oauth-token-endpoint',
    category: 'OAuth',
    destination: "Each OAuth MCP server's identity-provider token URL",
    data_sent: 'Authorization codes and refresh tokens during the OAuth exchange',
    purpose: 'Obtain access tokens so MCP tools can call third-party APIs on your behalf.',
    how_to_disable: 'Remove OAuth MCP servers from Connectors, or turn on offline mode.',
  },
  {
    id: 'remote-mcp-server',
    category: 'Tools',
    destination: 'Each configured remote MCP server URL',
    data_sent: 'Tool names, tool arguments, and tool results',
    purpose: 'Run tools hosted outside this box, such as hosted integrations.',
    how_to_disable: 'Remove the remote MCP server from Connectors, or turn on offline mode.',
  },
  {
    id: 'sandbox-provider',
    category: 'Code execution',
    destination: 'The configured remote sandbox provider API (Daytona or TrueForge cloud)',
    data_sent: 'Code to execute, plus files and results the code produces',
    purpose: 'Run untrusted or dependency-heavy code off the host box.',
    how_to_disable: 'Use the local sandbox provider instead, or turn on offline mode.',
  },
  {
    id: 'skill-git-remote',
    category: 'Skills',
    destination: 'The git remote URL of each installed git skill',
    data_sent: 'Nothing is uploaded. Repositories are cloned or pulled.',
    purpose: 'Install and update skills from git repositories.',
    how_to_disable: 'Remove git skills to stop these downloads. They run git inside the sandbox, outside the server fetch boundary, so offline mode does not block them; the sandbox egress allowlist still applies.',
  },
];

export function getDataFlowManifest(): DataFlowManifest {
  return { version: DATA_FLOW_MANIFEST_VERSION, connections: CONNECTIONS.map(c => ({ ...c })) };
}
