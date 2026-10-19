/**
 * Argument checking before a call is sent: safe repairs happen silently (boolean text to a real
 * boolean, unknown arguments dropped), and what cannot be repaired comes back as plain problems,
 * never as a provider's raw validation text.
 */
import {
  checkToolArguments,
  toolArgumentProblemMessage,
  toParameterSchema,
} from '../../../src/core/mcp/toolArgumentCheck';

const FETCH_SCHEMA = toParameterSchema({
  type: 'object',
  properties: {
    urls: { type: 'array', items: { type: 'string' } },
    full_content: { type: 'boolean' },
    objective: { type: 'string' },
  },
  required: ['urls'],
});

const EVENT_SCHEMA = toParameterSchema({
  type: 'object',
  properties: {
    title: { type: 'string' },
    start: {
      type: 'object',
      properties: {
        date_time: { type: 'string' },
        time_zone: { type: 'string' },
      },
      required: ['date_time'],
    },
    attendees: {
      type: 'array',
      items: {
        type: 'object',
        properties: { email: { type: 'string' }, optional: { type: 'boolean' } },
        required: ['email'],
      },
    },
  },
  required: ['title', 'start'],
});

describe('checkToolArguments', () => {
  it('coerces "true" and "false" text to real booleans', () => {
    const outcome = checkToolArguments({
      schema: FETCH_SCHEMA,
      args: { urls: ['https://example.com'], full_content: 'true' },
    });
    expect(outcome.problems).toEqual([]);
    expect(outcome.args['full_content']).toBe(true);
  });

  it('catches the "[" failure: a bracket string for a boolean is a problem, not a send', () => {
    const outcome = checkToolArguments({
      schema: FETCH_SCHEMA,
      args: { urls: ['https://example.com'], full_content: '[' },
    });
    expect(outcome.problems).toEqual([{ path: 'full_content', expected: 'true or false' }]);
    const message = toolArgumentProblemMessage({ toolName: 'web_fetch', problems: outcome.problems });
    expect(message).toContain('web_fetch');
    expect(message).toContain('full_content should be true or false');
    expect(message).toContain('was not sent');
    // Nothing provider-shaped: no validation jargon, no schema dump.
    expect(message).not.toContain('anyOf');
    expect(message).not.toContain('invalid_type');
  });

  it('drops arguments the schema does not have', () => {
    const outcome = checkToolArguments({
      schema: FETCH_SCHEMA,
      args: { urls: ['https://example.com'], full_content: true, surprise: 'x', another: 3 },
    });
    expect(outcome.problems).toEqual([]);
    expect(outcome.args).toEqual({ urls: ['https://example.com'], full_content: true });
  });

  it('drops an explicit null for an optional argument instead of failing on it', () => {
    const outcome = checkToolArguments({
      schema: FETCH_SCHEMA,
      args: { urls: ['https://example.com'], objective: null },
    });
    expect(outcome.problems).toEqual([]);
    expect(outcome.args).toEqual({ urls: ['https://example.com'] });
  });

  it('reports a missing required argument by name and what it should be', () => {
    const outcome = checkToolArguments({ schema: FETCH_SCHEMA, args: { full_content: true } });
    expect(outcome.problems).toHaveLength(1);
    expect(outcome.problems[0]?.path).toBe('urls');
    expect(outcome.problems[0]?.expected).toContain('required');
  });

  it('checks nested objects and list items, with paths the model can follow', () => {
    const outcome = checkToolArguments({
      schema: EVENT_SCHEMA,
      args: {
        title: 'Dentist',
        start: { date_time: '2026-10-27T14:30:00', zone_typo: 'x' },
        attendees: [{ email: 'sam@example.com', optional: 'false' }, { optional: true }],
      },
    });
    // zone_typo dropped, optional coerced; the second attendee has no email: one problem.
    expect(outcome.problems).toEqual([
      { path: 'attendees[1].email', expected: 'text (this one is required)' },
    ]);
    expect(outcome.args['start']).toEqual({ date_time: '2026-10-27T14:30:00' });
    expect(outcome.args['attendees']).toEqual([
      { email: 'sam@example.com', optional: false },
      { optional: true },
    ]);
  });

  it('leaves a free-form object schema untouched', () => {
    const schema = toParameterSchema({ type: 'object', properties: {} });
    const outcome = checkToolArguments({ schema, args: { anything: 1, goes: 'here' } });
    expect(outcome.problems).toEqual([]);
    expect(outcome.args).toEqual({ anything: 1, goes: 'here' });
  });

  it('accepts a value that fits either side of a union, repaired in the fitting side', () => {
    const schema = toParameterSchema({
      type: 'object',
      properties: { limit: { anyOf: [{ type: 'integer' }, { type: 'string' }] } },
    });
    expect(checkToolArguments({ schema, args: { limit: 5 } }).problems).toEqual([]);
    expect(checkToolArguments({ schema, args: { limit: 'five' } }).problems).toEqual([]);
    expect(checkToolArguments({ schema, args: { limit: true } }).problems).toEqual([
      { path: 'limit', expected: 'a number or text' },
    ]);
  });

  it('checks enum values and says what the choices are', () => {
    const schema = toParameterSchema({
      type: 'object',
      properties: { send_updates: { type: 'string', enum: ['all', 'none'] } },
    });
    expect(checkToolArguments({ schema, args: { send_updates: 'all' } }).problems).toEqual([]);
    expect(checkToolArguments({ schema, args: { send_updates: 'some' } }).problems).toEqual([
      { path: 'send_updates', expected: 'one of: all, none' },
    ]);
  });
});
