/**
 * The app log must tell a turn's tool story: one line per completed tool call carrying the tool
 * name, its outcome, and the session and turn ids, so an incident can be found by grepping the
 * tool name, the word error, or an id. Argument and result bodies never appear in the log; a
 * failed call's error text does, cut to a sane length.
 */
import { Writable } from 'node:stream';
import type { Logger } from 'winston';
import winston from 'winston';
import { EventType } from '../../src/agent-session/schemas/events';
import { toolResultResponse } from '../../src/core/mcp/IMCPServer';
import { TOOL_CALL_LOG_ERROR_MAX_LENGTH } from '../../src/core/runtime/AgentThread';
import { searchStream, setupSearchChat, textStream } from './searchTurnHarness';

interface CapturedLine {
  level: unknown;
  message: unknown;
  toolName: unknown;
  toolCallId: unknown;
  disposition: unknown;
  sessionId: unknown;
  turnId: unknown;
  error: unknown;
}

function captureLine(line: string): CapturedLine {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('A captured log line was not a JSON object');
  }
  return {
    level: Reflect.get(parsed, 'level'),
    message: Reflect.get(parsed, 'message'),
    toolName: Reflect.get(parsed, 'toolName'),
    toolCallId: Reflect.get(parsed, 'toolCallId'),
    disposition: Reflect.get(parsed, 'disposition'),
    sessionId: Reflect.get(parsed, 'sessionId'),
    turnId: Reflect.get(parsed, 'turnId'),
    error: Reflect.get(parsed, 'error'),
  };
}

/** A real winston logger at the app's level, writing JSON lines a test can read back. */
function makeCapturingLogger(): { logger: Logger; lines: () => CapturedLine[]; raw: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [new winston.transports.Stream({ stream })],
  });
  const raw = () => chunks.join('');
  const lines = () =>
    raw()
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(captureLine);
  return { logger, lines, raw };
}

function onlyToolCallLine(lines: CapturedLine[]): CapturedLine {
  const entries = lines.filter(line => typeof line.toolName === 'string');
  if (entries.length !== 1) {
    throw new Error(`Expected exactly one tool call log line, saw ${String(entries.length)}`);
  }
  const [entry] = entries;
  if (entry === undefined) {
    throw new Error('Expected exactly one tool call log line, saw none');
  }
  return entry;
}

const say = (text: string) => [{ type: EventType.USER_MESSAGE, content: text }];

describe('tool call logging', () => {
  it('logs a successful call at info with the tool name, outcome, session id and turn id, and no bodies', async () => {
    const capture = makeCapturingLogger();
    const chat = await setupSearchChat({ logger: capture.logger });
    chat.callTool.mockImplementationOnce(() =>
      Promise.resolve(toolResultResponse({ text: 'RESULT_BODY_THAT_MUST_NOT_BE_LOGGED' })),
    );
    chat.create
      .mockImplementationOnce(() => searchStream({ id: 'call-1', args: { query: 'ARGUMENT_THAT_MUST_NOT_BE_LOGGED' } }))
      .mockImplementation(() => textStream('Here is what I found.'));

    const turn = await chat.run({ messages: say('Look something up for me') });

    const entry = onlyToolCallLine(capture.lines());
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('Tool call lookup: executed_ok');
    expect(entry.toolName).toBe('lookup');
    expect(entry.toolCallId).toBe('call-1');
    expect(entry.disposition).toBe('executed_ok');
    expect(entry.sessionId).toBe(chat.session_id);
    expect(entry.turnId).toBe(turn.id);
    expect(entry.error).toBeUndefined();
    expect(capture.raw()).not.toContain('ARGUMENT_THAT_MUST_NOT_BE_LOGGED');
    expect(capture.raw()).not.toContain('RESULT_BODY_THAT_MUST_NOT_BE_LOGGED');
  });

  it('logs a failed call at warn with its outcome and error text', async () => {
    const capture = makeCapturingLogger();
    const chat = await setupSearchChat({ logger: capture.logger });
    chat.callTool.mockImplementationOnce(() =>
      Promise.resolve(toolResultResponse({ text: 'The lookup service is unavailable right now.', isError: true })),
    );
    chat.create
      .mockImplementationOnce(() => searchStream({ id: 'call-9', args: { query: 'anything' } }))
      .mockImplementation(() => textStream('I could not look that up.'));

    const turn = await chat.run({ messages: say('Look something up for me') });

    const entry = onlyToolCallLine(capture.lines());
    expect(entry.level).toBe('warn');
    expect(entry.message).toBe('Tool call lookup: executed_nonzero');
    expect(entry.toolName).toBe('lookup');
    expect(entry.toolCallId).toBe('call-9');
    expect(entry.disposition).toBe('executed_nonzero');
    expect(entry.sessionId).toBe(chat.session_id);
    expect(entry.turnId).toBe(turn.id);
    expect(entry.error).toBe('The lookup service is unavailable right now.');
  });

  it('cuts a long error text to the cap instead of logging it whole', async () => {
    const capture = makeCapturingLogger();
    const chat = await setupSearchChat({ logger: capture.logger });
    const longError = `Refused: ${'this write is too large. '.repeat(60)}`;
    chat.callTool.mockImplementationOnce(() => Promise.resolve(toolResultResponse({ text: longError, isError: true })));
    chat.create
      .mockImplementationOnce(() => searchStream({ id: 'call-3', args: { query: 'anything' } }))
      .mockImplementation(() => textStream('That did not work.'));

    await chat.run({ messages: say('Look something up for me') });

    const entry = onlyToolCallLine(capture.lines());
    expect(entry.level).toBe('warn');
    expect(entry.error).toBe(longError.slice(0, TOOL_CALL_LOG_ERROR_MAX_LENGTH));
    expect(capture.raw()).not.toContain(longError);
  });
});
