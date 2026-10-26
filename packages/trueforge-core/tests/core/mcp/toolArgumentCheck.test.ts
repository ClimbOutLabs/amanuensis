/**
 * Argument checking before a call is sent: safe repairs happen silently (boolean text to a real
 * boolean, unknown arguments dropped), and what cannot be repaired comes back as plain problems,
 * never as a provider's raw validation text.
 */
import {
  checkToolArguments,
  dropUnnamedArguments,
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
      readOnly: false,
    });
    expect(outcome.problems).toEqual([]);
    expect(outcome.args['full_content']).toBe(true);
  });

  it('catches the "[" failure: a bracket string for a boolean is a problem, not a send', () => {
    const outcome = checkToolArguments({
      schema: FETCH_SCHEMA,
      args: { urls: ['https://example.com'], full_content: '[' },
      readOnly: false,
    });
    expect(outcome.problems).toEqual([
      { path: 'full_content', expected: 'true or false', example: 'true', optional: true },
    ]);
    const message = toolArgumentProblemMessage({ toolName: 'web_fetch', problems: outcome.problems });
    expect(message).toContain('web_fetch');
    expect(message).toContain('full_content must be true or false, for example "full_content": true, or leave it out');
    expect(message).toContain('was not sent');
    // Nothing provider-shaped: no validation jargon, no schema dump.
    expect(message).not.toContain('anyOf');
    expect(message).not.toContain('invalid_type');
  });

  it('drops arguments the schema does not have', () => {
    const outcome = checkToolArguments({
      schema: FETCH_SCHEMA,
      args: { urls: ['https://example.com'], full_content: true, surprise: 'x', another: 3 },
      readOnly: false,
    });
    expect(outcome.problems).toEqual([]);
    expect(outcome.args).toEqual({ urls: ['https://example.com'], full_content: true });
  });

  it('drops an explicit null for an optional argument instead of failing on it', () => {
    const outcome = checkToolArguments({
      schema: FETCH_SCHEMA,
      args: { urls: ['https://example.com'], objective: null },
      readOnly: false,
    });
    expect(outcome.problems).toEqual([]);
    expect(outcome.args).toEqual({ urls: ['https://example.com'] });
  });

  it('reports a missing required argument by name and what it should be', () => {
    const outcome = checkToolArguments({ schema: FETCH_SCHEMA, args: { full_content: true }, readOnly: false });
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
      readOnly: false,
    });
    // zone_typo dropped, optional coerced; the second attendee has no email: one problem.
    expect(outcome.problems).toEqual([{ path: 'attendees[1].email', expected: 'text (this one is required)', example: undefined, optional: false }]);
    expect(outcome.args['start']).toEqual({ date_time: '2026-10-27T14:30:00' });
    expect(outcome.args['attendees']).toEqual([{ email: 'sam@example.com', optional: false }, { optional: true }]);
  });

  it('leaves a free-form object schema untouched', () => {
    const schema = toParameterSchema({ type: 'object', properties: {} });
    const outcome = checkToolArguments({ schema, args: { anything: 1, goes: 'here' }, readOnly: false });
    expect(outcome.problems).toEqual([]);
    expect(outcome.args).toEqual({ anything: 1, goes: 'here' });
  });

  it('accepts a value that fits either side of a union, repaired in the fitting side', () => {
    const schema = toParameterSchema({
      type: 'object',
      properties: { limit: { anyOf: [{ type: 'integer' }, { type: 'string' }] } },
    });
    expect(checkToolArguments({ schema, args: { limit: 5 }, readOnly: false }).problems).toEqual([]);
    expect(checkToolArguments({ schema, args: { limit: 'five' }, readOnly: false }).problems).toEqual([]);
    expect(checkToolArguments({ schema, args: { limit: true }, readOnly: false }).problems).toEqual([
      { path: 'limit', expected: 'a number or text', example: undefined, optional: true },
    ]);
  });

  it('checks enum values and says what the choices are', () => {
    const schema = toParameterSchema({
      type: 'object',
      properties: { send_updates: { type: 'string', enum: ['all', 'none'] } },
    });
    expect(checkToolArguments({ schema, args: { send_updates: 'all' }, readOnly: false }).problems).toEqual([]);
    expect(checkToolArguments({ schema, args: { send_updates: 'some' }, readOnly: false }).problems).toEqual([
      { path: 'send_updates', expected: 'one of: all, none', example: undefined, optional: true },
    ]);
  });

  it('coerces boolean text with any casing and padding', () => {
    const schema = toParameterSchema({
      type: 'object',
      properties: { a: { type: 'boolean' }, b: { type: 'boolean' } },
    });
    const outcome = checkToolArguments({ schema, args: { a: ' TRUE ', b: 'False' }, readOnly: false });
    expect(outcome.problems).toEqual([]);
    expect(outcome.args).toEqual({ a: true, b: false });
  });

  it('flags an extra argument that breaks the additionalProperties schema', () => {
    const schema = toParameterSchema({
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: { type: 'string' },
    });
    const outcome = checkToolArguments({ schema, args: { name: 'x', extra: 5 }, readOnly: false });
    expect(outcome.problems).toEqual([{ path: 'extra', expected: 'text', example: undefined, optional: false }]);
  });

  it('keeps an argument whose property schema is the boolean true (any value allowed)', () => {
    const schema = toParameterSchema({
      type: 'object',
      properties: { options: true, name: { type: 'string' } },
      required: ['options', 'name'],
    });
    const outcome = checkToolArguments({ schema, args: { options: { a: 1 }, name: 'x' }, readOnly: false });
    expect(outcome.problems).toEqual([]);
    expect(outcome.args).toEqual({ options: { a: 1 }, name: 'x' });
  });

  it('keeps arguments declared under allOf instead of dropping them', () => {
    const schema = toParameterSchema({
      type: 'object',
      properties: { title: { type: 'string' } },
      allOf: [{ properties: { room: { type: 'string' } }, required: ['room'] }],
    });
    const outcome = checkToolArguments({ schema, args: { title: 'Dentist', room: '2B' }, readOnly: false });
    expect(outcome.problems).toEqual([]);
    expect(outcome.args).toEqual({ title: 'Dentist', room: '2B' });
    // A field required only under allOf is still reported when it is missing.
    expect(checkToolArguments({ schema, args: { title: 'Dentist' }, readOnly: false }).problems).toEqual([
      { path: 'room', expected: 'text (this one is required)', example: undefined, optional: false },
    ]);
  });

  it('flags an argument whose property schema is the boolean false (no value allowed)', () => {
    const schema = toParameterSchema({
      type: 'object',
      properties: { options: false, name: { type: 'string' } },
    });
    const outcome = checkToolArguments({ schema, args: { options: { a: 1 }, name: 'x' }, readOnly: false });
    expect(outcome.problems).toEqual([
      {
        path: 'options',
        expected: 'left out (this tool does not take a value here)',
        example: undefined,
        optional: true,
      },
    ]);
    // Leaving the forbidden argument out is fine.
    expect(checkToolArguments({ schema, args: { name: 'x' }, readOnly: false }).problems).toEqual([]);
  });

  it('drops an optional true-or-false value it cannot repair when the tool is read-only, so the call can run', () => {
    const outcome = checkToolArguments({
      schema: FETCH_SCHEMA,
      args: { urls: ['https://example.com'], full_content: '> ' },
      readOnly: true,
    });
    expect(outcome.problems).toEqual([]);
    expect(outcome.args).toEqual({ urls: ['https://example.com'] });
  });

  it('still refuses an unusable optional true-or-false value for a tool that changes something', () => {
    const outcome = checkToolArguments({
      schema: FETCH_SCHEMA,
      args: { urls: ['https://example.com'], full_content: '> ' },
      readOnly: false,
    });
    expect(outcome.problems).toEqual([
      { path: 'full_content', expected: 'true or false', example: 'true', optional: true },
    ]);
  });

  it('never drops a required true-or-false value, even for a read-only tool', () => {
    const schema = toParameterSchema({
      type: 'object',
      properties: { confirm: { type: 'boolean' } },
      required: ['confirm'],
    });
    const outcome = checkToolArguments({ schema, args: { confirm: '> ' }, readOnly: true });
    expect(outcome.problems).toEqual([{ path: 'confirm', expected: 'true or false', example: 'true', optional: false }]);
    expect(toolArgumentProblemMessage({ toolName: 'confirm_tool', problems: outcome.problems })).toContain(
      'confirm must be true or false, for example "confirm": true.',
    );
  });
});

/** The shape of an edit call to a page the person keeps: a list whose entries are either of two kinds. */
const EDIT_PAGE_SCHEMA = toParameterSchema({
  type: 'object',
  properties: {
    page_name: { type: 'string' },
    edits: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'search' },
              search: { type: 'string', minLength: 1 },
              replace: { type: 'string' },
            },
            required: ['type', 'search', 'replace'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'block' },
              anchor: { type: 'string' },
              new_content: { type: 'string' },
            },
            required: ['type', 'anchor', 'new_content'],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ['page_name', 'edits'],
});

describe('a value that fits none of several object shapes', () => {
  function problemFor(edit: unknown) {
    const outcome = checkToolArguments({
      schema: EDIT_PAGE_SCHEMA,
      args: { page_name: 'Harbour Market Plan', edits: [edit] },
      readOnly: false,
    });
    return outcome.problems;
  }

  it('names the fields each option needs, using the real field names', () => {
    const [problem] = problemFor({ find: 'Tomatoes', with: 'Basil' });
    expect(problem?.path).toBe('edits[0]');
    expect(problem?.expected).toBe(
      'either an object with type set to "search", search (text) and replace (text), ' +
        'or an object with type set to "block", anchor (text) and new_content (text)',
    );
  });

  it('never says the same thing twice in one message', () => {
    const message = toolArgumentProblemMessage({
      toolName: 'edit_page',
      problems: problemFor('Tomatoes become Basil'),
    });
    expect(message).toContain('edits[0] must be either an object with type set to "search"');
    expect(message).not.toContain('named fields');
    const options = message.split(/\bor an object\b/);
    expect(options).toHaveLength(2);
    expect(options[0]).not.toEqual(options[1]);
  });

  it('holds a value that names its own option to that option, and points at the missing field', () => {
    expect(problemFor({ type: 'search', search: 'Tomatoes' })).toEqual([
      { path: 'edits[0].replace', expected: 'text (this one is required)', example: undefined, optional: false },
    ]);
  });

  it('still accepts a well-formed entry of either kind', () => {
    expect(problemFor({ type: 'search', search: 'Tomatoes', replace: 'Basil' })).toEqual([]);
    expect(problemFor({ type: 'block', anchor: 'intro', new_content: 'Hello' })).toEqual([]);
  });

  it('reads any union alike, naming a plain option as plainly as an object one', () => {
    const schema = toParameterSchema({
      type: 'object',
      properties: {
        when: {
          anyOf: [
            { type: 'string' },
            { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from'] },
          ],
        },
      },
    });
    const outcome = checkToolArguments({ schema, args: { when: 42 }, readOnly: false });
    expect(outcome.problems).toEqual([
      {
        path: 'when',
        expected: 'either text, or an object with from (text), and optionally to',
        example: undefined,
        optional: true,
      },
    ]);
  });

  it('collapses options that read the same into one phrase', () => {
    const schema = toParameterSchema({
      type: 'object',
      properties: { limit: { anyOf: [{ type: 'string' }, { type: 'string', minLength: 2 }] } },
    });
    const outcome = checkToolArguments({ schema, args: { limit: 3 }, readOnly: false });
    expect(outcome.problems[0]?.expected).toBe('text');
  });

  it('lists at most a few optional fields, then says there are more', () => {
    const fields = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(name => [name, { type: 'string' }]));
    const schema = toParameterSchema({
      type: 'object',
      properties: { box: { type: 'object', properties: fields } },
    });
    const outcome = checkToolArguments({ schema, args: { box: 'x' }, readOnly: false });
    expect(outcome.problems[0]?.expected).toBe('an object with the optional fields a, b, c, d, e, f and more');
  });
});

describe('dropUnnamedArguments', () => {
  const named = { type: 'object', properties: { query: { type: 'string' } } };

  it('drops only the arguments a named-fields schema does not name', () => {
    expect(dropUnnamedArguments({ schema: named, args: { query: 'agenda', session_id: 'x' } })).toEqual({
      args: { query: 'agenda' },
      dropped: ['session_id'],
    });
  });

  it('keeps everything when the schema allows extra arguments or names none', () => {
    const args = { query: 'agenda', session_id: 'x' };
    expect(dropUnnamedArguments({ schema: { ...named, additionalProperties: true }, args }).dropped).toEqual([]);
    expect(dropUnnamedArguments({ schema: { type: 'object' }, args }).dropped).toEqual([]);
  });
});
