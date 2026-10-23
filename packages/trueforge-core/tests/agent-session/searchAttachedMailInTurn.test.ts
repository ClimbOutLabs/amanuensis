/**
 * A mail the person attaches can carry its body encoded, so the words the model reads after decoding it are not the
 * bytes the upload saw. The chat cannot vouch for what such a file says, so a search that names its sender asks.
 */
import { EventType } from '../../src/agent-session/schemas/events';
import { holdSay } from '../../src/core/permissions/searchHoldText';
import { DEFAULT_ASSISTANT_NAME } from '../../src/core/personas/assistantName';
import '../core/harnessMocks';
import { makeStubPublicSandbox } from '../core/harnessMocks';
import { searchStream, setupSearchChat, textStream } from './searchTurnHarness';

const HOLD_SAY = holdSay(DEFAULT_ASSISTANT_NAME);

/** Invented details only. */
const NAME = 'Ottilie Vanbrugh-Carrow';

const MAIL = [
  'From: landlord@example.test',
  'Subject: Lease',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from(`Tenant: ${NAME}.`).toString('base64'),
].join('\r\n');

describe('a mail attached through the upload path', () => {
  it.each([
    ['lease.eml', 'message/rfc822'],
    ['lease.txt', 'text/plain'],
  ])('asks before a search for a name in the encoded body of %s', async (name, mime) => {
    const sandbox = makeStubPublicSandbox();
    jest
      .spyOn(sandbox, 'uploadUserFile')
      .mockImplementation(input => Promise.resolve({ filePath: `/tmp/uploads/${input.fileName}` }));
    const chat = await setupSearchChat({ sandbox });
    chat.create.mockImplementationOnce(() => searchStream({ id: 'call-1', query: `${NAME} lease` }));
    chat.create.mockImplementation(() => textStream('Done.'));

    const turn = await chat.run({
      messages: [
        {
          type: EventType.USER_MESSAGE,
          content: [
            { type: 'text', text: 'Who is the tenant?' },
            {
              type: 'file',
              name,
              data: `data:${mime};base64,${Buffer.from(MAIL).toString('base64')}`,
            },
          ],
        },
      ],
    });
    const state = (await chat.session.getTurn(turn.id))?.state;

    expect(state).toMatchObject({ status: 'done', required_actions: [{ type: EventType.TOOL_APPROVAL_REQUIRED }] });
    expect(JSON.stringify(state)).toContain(HOLD_SAY.private_unchecked);
    expect(chat.callTool).not.toHaveBeenCalled();
  });
});

describe('a mail saved as .txt whose only encoding is the sender name', () => {
  it.each([
    ['base64', '=?UTF-8?B?T3R0aWxpZSBWYW5l?='],
    ['quoted-printable', '=?UTF-8?Q?Ottilie_Vane?='],
  ])('asks before a search for the %s-encoded sender name', async (_form, encodedName) => {
    const sandbox = makeStubPublicSandbox();
    jest
      .spyOn(sandbox, 'uploadUserFile')
      .mockImplementation(input => Promise.resolve({ filePath: `/tmp/uploads/${input.fileName}` }));
    const chat = await setupSearchChat({ sandbox });
    chat.create.mockImplementationOnce(() => searchStream({ id: 'call-1', query: 'Ottilie Vane lease' }));
    chat.create.mockImplementation(() => textStream('Done.'));
    const mail = [`From: ${encodedName} <ov@example.test>`, 'Subject: Lease', '', 'The lease is attached.'].join(
      '\r\n',
    );

    const turn = await chat.run({
      messages: [
        {
          type: EventType.USER_MESSAGE,
          content: [
            { type: 'text', text: 'Who sent this?' },
            {
              type: 'file',
              name: 'lease.eml.txt',
              data: `data:text/plain;base64,${Buffer.from(mail).toString('base64')}`,
            },
          ],
        },
      ],
    });
    const state = (await chat.session.getTurn(turn.id))?.state;

    expect(state).toMatchObject({ status: 'done', required_actions: [{ type: EventType.TOOL_APPROVAL_REQUIRED }] });
    expect(JSON.stringify(state)).toContain(HOLD_SAY.private_unchecked);
    expect(chat.callTool).not.toHaveBeenCalled();
  });
});
