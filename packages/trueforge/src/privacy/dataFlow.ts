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
  {
    id: 'oidc-discovery',
    category: 'Auth',
    destination: 'The configured OIDC issuer URL (OIDC_ISSUER_URL)',
    data_sent: 'Nothing user-authored. The issuer discovery document and signing keys (JWKS) are fetched.',
    purpose: 'Verify OIDC sign-in tokens when browser login is enabled.',
    how_to_disable: 'Leave the OIDC env vars unset to run in standalone mode with browser login off.',
  },
  {
    id: 'schedule-dispatch',
    category: 'Schedules',
    destination: 'The configured server URL (SERVER_URL), usually this same box',
    data_sent: 'Schedule run handoffs: the run id posted to the internal execute endpoint.',
    purpose: 'Hand due schedule runs from the dispatch loop to the server for execution.',
    how_to_disable: 'Schedules do not run without the dispatch loop. Turn on offline mode to block the handoff when SERVER_URL is non-local.',
  },
  {
    id: 'servicefoundry-api',
    category: 'Control plane',
    destination: 'The configured TrueFoundry ServiceFoundry server URL (TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL)',
    data_sent: 'Session lookups, agent and skill listings, MCP server info, and token vending; authenticated with the configured API key.',
    purpose: 'TrueFoundry control-plane integration in distributed mode.',
    how_to_disable: 'Leave TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL unset to run standalone, or turn on offline mode to block non-local destinations.',
  },
  {
    id: 'voice-stt-sidecar',
    category: 'Voice',
    destination: 'The configured speech-to-text sidecar URL (STT_URL; the aman-stt sidecar, local by default)',
    data_sent: 'Recorded audio bytes for transcription. Transcripts are never logged; only durations, byte counts, and status codes reach the logs.',
    purpose: 'Transcribe voice input from the browser.',
    how_to_disable: 'Stop the sidecar: the microphone hides while it is unreachable. Turn on offline mode to block non-local sidecar URLs.',
  },
];

export function getDataFlowManifest(): DataFlowManifest {
  return { version: DATA_FLOW_MANIFEST_VERSION, connections: CONNECTIONS.map(c => ({ ...c })) };
}
