/**
 * The search provider takes an objective and a list of queries, and the model can name its arguments as it likes.
 * Every text the call sends out is checked, the names of its arguments included.
 */
import { EventType } from '../../src/agent-session/schemas/events';
import { HOLD_SAY } from '../../src/core/permissions/searchHoldText';
import '../core/harnessMocks';
import { makeStubPublicSandbox } from '../core/harnessMocks';
import { searchStream, setupSearchChat, textStream } from './searchTurnHarness';

/** Invented details only. */
const NAME = 'Ottilie Vanbrugh-Carrow';
const CSV = `role,name\ntenant,${NAME}\n`;

async function attachAndSearch(args: Record<string, unknown>) {
  const sandbox = makeStubPublicSandbox();
  jest
    .spyOn(sandbox, 'uploadUserFile')
    .mockImplementation(input => Promise.resolve({ filePath: `/tmp/uploads/${input.fileName}` }));
  const chat = await setupSearchChat({ sandbox });
  chat.create.mockImplementationOnce(() => searchStream({ id: 'call-1', args }));
  chat.create.mockImplementation(() => textStream('Done.'));
  const turn = await chat.run({
    messages: [
      {
        type: EventType.USER_MESSAGE,
        content: [
          { type: 'text', text: 'Who is the tenant?' },
          { type: 'file', name: 'lease.csv', data: `data:text/csv;base64,${Buffer.from(CSV).toString('base64')}` },
        ],
      },
    ],
  });
  return { ...chat, state: (await chat.session.getTurn(turn.id))?.state };
}

describe('a search with the provider argument shape', () => {
  it.each([
    ['in a query', { objective: 'Find the tenant', search_queries: [`${NAME} lease`] }],
    ['in the objective', { objective: `Who is ${NAME}`, search_queries: ['lease'] }],
    ['in an argument name', { objective: 'lease', search_queries: ['lease'], [NAME]: 'x' }],
    ['in a nested argument name', { objective: 'lease', search_queries: [{ [NAME]: 1 }] }],
  ])('asks before it sends a name from an attached file %s', async (_where, args) => {
    const { state, callTool } = await attachAndSearch(args);

    expect(JSON.stringify(state)).toContain(HOLD_SAY.private_detail);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('runs a search that carries nothing from the file', async () => {
    const { callTool } = await attachAndSearch({ objective: 'Tenant law', search_queries: ['tenant rights'] });

    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
