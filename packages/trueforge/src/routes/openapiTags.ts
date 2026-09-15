/** Mintlify API Reference groups — the only OpenAPI `tags` values. */
export enum OpenApiTag {
  INTERNAL = 'Internal',
  AUTH = 'Auth',
  CAPABILITIES = 'Capabilities',
  MODELS = 'Models',
  MCP_SERVERS = 'MCP Servers',
  SKILLS = 'Skills',
  SANDBOXES = 'Sandboxes',
  AGENTS = 'Agents',
  SCHEDULES = 'Schedules',
  PERSONALIZATION = 'Personalization',
  PERSONAS = 'Personas',
  REPOSITORIES = 'Repositories',
  AGENT_SESSIONS = 'Agent Sessions',
  SPACES = 'Spaces',
}

/** Document-level tag order for `/api/v1/docs` and Mintlify. */
export const OPENAPI_DOCUMENT_TAGS: { name: OpenApiTag }[] = [
  { name: OpenApiTag.INTERNAL },
  { name: OpenApiTag.AUTH },
  { name: OpenApiTag.CAPABILITIES },
  { name: OpenApiTag.MODELS },
  { name: OpenApiTag.MCP_SERVERS },
  { name: OpenApiTag.SKILLS },
  { name: OpenApiTag.SANDBOXES },
  { name: OpenApiTag.AGENTS },
  { name: OpenApiTag.SCHEDULES },
  { name: OpenApiTag.PERSONALIZATION },
  { name: OpenApiTag.PERSONAS },
  { name: OpenApiTag.REPOSITORIES },
  { name: OpenApiTag.AGENT_SESSIONS },
  { name: OpenApiTag.SPACES },
];
