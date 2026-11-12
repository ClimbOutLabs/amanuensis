/**
 * A stub of the Maya world's Home Assistant, speaking the legacy SSE transport on
 * `/mcp_server/sse` the way the real Model Context Protocol Server integration does.
 *
 * The exposed entities are the demo world's set: a living room lamp, a hallway thermostat, a
 * front door lock, a garage door, and a "Leaving home" scene. Tools are Home Assistant's Assist
 * tools over those entities; the only observable effect of a change is the stub's own state and
 * invocation counters, so a test can say whether a call ran without touching a real home.
 *
 * With `integrationInstalled: false` the endpoint answers 404, as a Home Assistant without the
 * integration does. With `token` set, every request must carry it as a Bearer header or the
 * stub answers 401, as Home Assistant does for a token it does not know.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';

export const HOME_ASSISTANT_STUB_SERVER_NAME = 'home-assistant';

export const HA_CALL_ACTION_TOOL = 'call_action';
export const HA_UNFAMILIAR_TOOL = 'HassVacuumStart';
export const HA_LAMP = 'light.living_room_lamp';
export const HA_THERMOSTAT = 'climate.hallway_thermostat';
export const HA_LOCK = 'lock.front_door';
export const HA_GARAGE = 'cover.garage_door';
export const HA_SCENE = 'scene.leaving_home';

/** The heating line the morning brief proof reads: the thermostat is set to 22 while Maya is out. */
export const HA_HEATING_LINE = 'Hallway thermostat: heating, set to 22 degrees';

interface StubEntity {
  entity_id: string;
  name: string;
  state: string;
  device_class: string | null;
}

const ENTITIES: readonly StubEntity[] = [
  { entity_id: HA_LAMP, name: 'Living room lamp', state: 'on', device_class: null },
  { entity_id: HA_THERMOSTAT, name: 'Hallway thermostat', state: 'heating', device_class: null },
  { entity_id: HA_LOCK, name: 'Front door lock', state: 'locked', device_class: null },
  { entity_id: HA_GARAGE, name: 'Garage door', state: 'closed', device_class: 'garage' },
  { entity_id: HA_SCENE, name: 'Leaving home', state: 'off', device_class: null },
];

export interface HomeAssistantStub {
  /** SSE endpoint to register as the connector `url`: `<origin>/mcp_server/sse`. */
  url: string;
  origin: string;
  /** Times each change tool actually started executing. */
  invocations: (tool_name: string) => number;
  liveContextInvocations: () => number;
  /** The stub's current state for one entity, or undefined when it does not know it. */
  entityState: (entity_id: string) => string | undefined;
  /** The Authorization header the stub last saw, so a test can prove the token travelled as a header. */
  lastAuthorizationHeader: () => string | undefined;
  stop: () => Promise<void>;
}

const TARGET_ARGS = {
  name: z.string().optional().describe('Name of the entity to act on.'),
  entity_id: z.string().optional().describe('Entity id to act on.'),
};

export async function startHomeAssistantStub(
  options: {
    token?: string;
    integrationInstalled?: boolean;
    /** Adds the generic action tool and a change tool Aman has no wording for, as newer servers serve. */
    newerTools?: boolean;
  } = {},
): Promise<HomeAssistantStub> {
  const entities = new Map(ENTITIES.map(entity => [entity.entity_id, { ...entity }]));
  const counts = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the stub serves the legacy SSE transport Home Assistant exposes at /mcp_server/sse
  const sessions = new Map<string, SSEServerTransport>();
  let lastAuthorization: string | undefined;

  const count = (tool_name: string): void => {
    counts.set(tool_name, (counts.get(tool_name) ?? 0) + 1);
  };

  const findEntity = (args: { name?: string | undefined; entity_id?: string | undefined }): StubEntity | undefined => {
    if (args.entity_id !== undefined) {
      return entities.get(args.entity_id);
    }
    if (args.name !== undefined) {
      const wanted = args.name.trim().toLowerCase();
      return [...entities.values()].find(entity => entity.name.toLowerCase() === wanted);
    }
    return undefined;
  };

  const noMatch = {
    content: [{ type: 'text' as const, text: 'No matching entities are exposed to the assistant.' }],
    isError: true,
  };

  const buildServer = (): McpServer => {
    const server = new McpServer({ name: 'home-assistant-stub', version: '1.0.0' });
    server.registerTool(
      'GetLiveContext',
      {
        description: 'The current state of every exposed entity, in one call.',
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- the tool handler shape is async; the stub answers from memory
      async () => {
        count('GetLiveContext');
        const lines = [...entities.values()].map(entity =>
          entity.entity_id === HA_THERMOSTAT ? `- ${HA_HEATING_LINE}` : `- ${entity.name}: ${entity.state}`,
        );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );
    const change = (tool_name: string, apply: (entity: StubEntity, args: Record<string, unknown>) => string) =>
      server.registerTool(
        tool_name,
        {
          description: `Change one exposed entity with ${tool_name}.`,
          inputSchema: {
            ...TARGET_ARGS,
            temperature: z.number().optional(),
            position: z.number().optional(),
            brightness: z.number().optional(),
          },
          annotations: { readOnlyHint: false, openWorldHint: false },
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- the tool handler shape is async; the stub answers from memory
        async args => {
          count(tool_name);
          const entity = findEntity(args);
          if (entity === undefined) {
            return noMatch;
          }
          return { content: [{ type: 'text' as const, text: apply(entity, args) }] };
        },
      );
    change('HassTurnOn', entity => {
      entity.state = entity.entity_id === HA_LOCK ? 'unlocked' : 'on';
      return `Turned on ${entity.name}.`;
    });
    change('HassTurnOff', entity => {
      entity.state = entity.entity_id === HA_LOCK ? 'locked' : 'off';
      return `Turned off ${entity.name}.`;
    });
    change('HassLightSet', entity => `Set ${entity.name}.`);
    change('HassClimateSetTemperature', (entity, args) => {
      const temperature = typeof args['temperature'] === 'number' ? args['temperature'] : null;
      return temperature === null ? `Set ${entity.name}.` : `Set ${entity.name} to ${String(temperature)} degrees.`;
    });
    change('HassSetPosition', entity => `Set the position of ${entity.name}.`);
    if (options.newerTools === true) {
      change(HA_CALL_ACTION_TOOL, entity => `Ran an action on ${entity.name}.`);
      change(HA_UNFAMILIAR_TOOL, entity => `Started ${entity.name}.`);
    }
    return server;
  };

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    if (typeof header === 'string') {
      lastAuthorization = header;
    }
    return options.token === undefined || header === `Bearer ${options.token}`;
  };

  const httpServer: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/mcp_server/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (options.integrationInstalled === false) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'integration not installed' }));
      return;
    }
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/mcp_server/sse') {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- same legacy SSE transport as above
      const transport = new SSEServerTransport('/mcp_server/messages', res);
      sessions.set(transport.sessionId, transport);
      res.on('close', () => {
        sessions.delete(transport.sessionId);
      });
      await buildServer().connect(transport);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/mcp_server/messages') {
      const session = sessions.get(url.searchParams.get('sessionId') ?? '');
      if (session === undefined) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no session' }));
        return;
      }
      const body = await readBody(req);
      await session.handlePostMessage(req, res, body);
      return;
    }
    // The Streamable HTTP probe and anything else: not served here, as on a real Home Assistant.
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
  }

  await new Promise<void>(resolve => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('home assistant stub did not bind a port');
  }
  const origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    url: `${origin}/mcp_server/sse`,
    origin,
    invocations: (tool_name: string) => counts.get(tool_name) ?? 0,
    liveContextInvocations: () => counts.get('GetLiveContext') ?? 0,
    entityState: (entity_id: string) => entities.get(entity_id)?.state,
    lastAuthorizationHeader: () => lastAuthorization,
    stop: () =>
      new Promise<void>(resolve => {
        // The client holds its SSE stream open; close() alone would wait on it forever.
        httpServer.closeAllConnections();
        httpServer.close(() => {
          resolve();
        });
      }),
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', error => {
      reject(new Error('home assistant stub could not read the request body', { cause: error }));
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw === '' ? {} : JSON.parse(raw));
      } catch (error) {
        reject(new Error('home assistant stub received a non-JSON body', { cause: error }));
      }
    });
  });
}
