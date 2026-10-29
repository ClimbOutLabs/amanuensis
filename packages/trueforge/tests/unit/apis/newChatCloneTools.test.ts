import { z } from '@hono/zod-openapi';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { FakeSandboxProvider } from '../../fixtures/fakeSandboxProvider';

const TURN_TIMEOUT_MS = 60_000;
const CLONE_REQUEST =
  'Clone https://github.com/ClimbOutLabs/exitramp.git into a new folder named exitramp in the workspace, then check out the main branch.';

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function createSession(input: { server: ApprovalTestServer; sandbox: { enabled: boolean } | undefined }) {
  const spec = {
    model: { name: MODEL_FQN },
    instructions: 'Answer plainly.',
    ...(input.sandbox === undefined ? {} : { config: { sandbox: input.sandbox } }),
  };
  const response = await input.server.request('/api/v1/sessions', jsonInit({ agent: { spec } }));
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`session create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
}

async function offeredToolNames(input: { server: ApprovalTestServer; sessionId: string }): Promise<string[]> {
  const response = await input.server.request(
    `/api/v1/sessions/${input.sessionId}/turns`,
    jsonInit({ input: [{ type: 'user.message', content: CLONE_REQUEST }], stream: true }),
  );
  if (response.status !== 200) {
    throw new Error(`turn create failed (${String(response.status)}): ${await response.text()}`);
  }
  await response.text();
  const first = input.server.model.requests().find(request => request.tools.length > 0);
  return (first?.tools ?? []).flatMap(tool => (typeof tool.function?.name === 'string' ? [tool.function.name] : []));
}

describe('a new chat without skills that asks to clone a repository', () => {
  it(
    'is offered the shell and code tools once its sandbox is on',
    async () => {
      const server = await startApprovalTestServer({ sandboxProvider: new FakeSandboxProvider(new Map()) });
      try {
        // The new chat bridge turns the sandbox on for a clone request; skills are not needed for it.
        const sessionId = await createSession({ server, sandbox: { enabled: true } });
        const tools = await offeredToolNames({ server, sessionId });
        expect(tools).toEqual(expect.arrayContaining(['exec', 'run_code']));
      } finally {
        await server.close();
      }
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'has no shell tool when the chat sends no sandbox setting, which is why the bridge must turn it on',
    async () => {
      const server = await startApprovalTestServer({ sandboxProvider: new FakeSandboxProvider(new Map()) });
      try {
        const sessionId = await createSession({ server, sandbox: undefined });
        const tools = await offeredToolNames({ server, sessionId });
        expect(tools).not.toContain('exec');
        expect(tools).not.toContain('run_code');
      } finally {
        await server.close();
      }
    },
    TURN_TIMEOUT_MS,
  );
});
