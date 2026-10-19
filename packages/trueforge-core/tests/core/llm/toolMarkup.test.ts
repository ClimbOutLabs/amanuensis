/**
 * Leaked tool-call markup: the streaming filter must never release markup text, and the parser
 * must rebuild only complete, well-formed calls. Anything half-formed or invented is broken.
 */
import { parseToolMarkup, ToolMarkupGuard } from '../../../src/core/llm/toolMarkup';

const DSML_CREATE =
  '<｜DSML｜tool_calls>\n' +
  '<｜DSML｜invoke name="create_event">\n' +
  '<｜DSML｜parameter name="title" string="true">Dentist appointment</｜DSML｜parameter>\n' +
  '<｜DSML｜parameter name="start" string="false">{"date_time": "2026-10-27T14:30:00", "time_zone": "America/New_York"}</｜DSML｜parameter>\n' +
  '<｜DSML｜parameter name="attendees" string="false">[{"email": "sam@example.com"}]</｜DSML｜parameter>\n' +
  '</｜DSML｜invoke>\n' +
  '</｜DSML｜tool_calls>';

describe('ToolMarkupGuard streaming filter', () => {
  it('passes ordinary text through, holding back only a possible opener tail', () => {
    const guard = new ToolMarkupGuard();
    expect(guard.push('Hello there. ')).toBe('Hello there. ');
    expect(guard.push('a < b and c > d')).toBe('a < b and c > d');
    expect(guard.inMarkup).toBe(false);
    expect(guard.finish()).toEqual({ status: 'clean' });
  });

  it('holds a partial opener until the next piece settles it', () => {
    const guard = new ToolMarkupGuard();
    // The piece ends mid-tag: nothing after the last safe character may be released yet.
    expect(guard.push('Working on it <')).toBe('Working on it ');
    expect(guard.push('b>not markup</b>')).toBe('<b>not markup</b>');
    expect(guard.finish()).toEqual({ status: 'clean' });
  });

  it('never releases DSML markup split across pieces, nor the claim after it', () => {
    const guard = new ToolMarkupGuard();
    const released: string[] = [];
    released.push(guard.push('Let me add that. '));
    released.push(guard.push('<｜DSM'));
    released.push(guard.push('L｜tool_calls><｜DSML｜invoke name="create_event">'));
    released.push(guard.push('<｜DSML｜parameter name="title" string="true">Dentist</｜DSML｜parameter>'));
    released.push(guard.push('</｜DSML｜invoke></｜DSML｜tool_calls>'));
    released.push(guard.push(' Done, I added the appointment to your calendar.'));
    const shown = released.join('');
    expect(shown).toBe('Let me add that. ');
    expect(shown).not.toContain('DSML');
    expect(shown).not.toContain('added the appointment');
    expect(guard.finish().status).toBe('recovered');
  });

  it('never releases a function_results block', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Checking now. <function_results>The event was added.</function_results> All done.');
    expect(shown).toBe('Checking now. ');
    expect(guard.finish()).toEqual({ status: 'broken' });
  });

  it('keeps markup shown as an example inside a fenced code block as text', () => {
    const guard = new ToolMarkupGuard();
    const text =
      'Here is what the markup looks like:\n```\n<tool_call>{"name": "get_event", "arguments": {"event_id": "evt-1"}}</tool_call>\n```\nThat is the whole shape.';
    const shown = guard.push(text);
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toEqual({ status: 'clean' });
  });

  it('keeps a fenced example as text when it streams in pieces, split inside the fence and the markup', () => {
    const guard = new ToolMarkupGuard();
    const text = 'Example:\n```\n<｜DSML｜invoke name="create_event"></｜DSML｜invoke>\n```\nEnd of example.';
    let shown = '';
    for (const piece of [
      'Example:\n`',
      '``\n<｜DS',
      'ML｜invoke name="create_event"></｜DSML｜invoke>\n`',
      '``\nEnd of example.',
    ]) {
      shown += guard.push(piece);
      expect(guard.inMarkup).toBe(false);
    }
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toEqual({ status: 'clean' });
  });

  it('still captures markup that comes after a fenced example closes', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push(
      'Example:\n```\n<tool_call>{"name": "get_event", "arguments": {"event_id": "evt-1"}}</tool_call>\n```\nNow for real: ' +
        '<tool_call>{"name": "get_event", "arguments": {"event_id": "evt-2"}}</tool_call>',
    );
    expect(shown).toContain('evt-1');
    expect(shown).not.toContain('evt-2');
    expect(guard.finish()).toEqual({
      status: 'recovered',
      calls: [{ name: 'get_event', arguments: { event_id: 'evt-2' } }],
    });
  });

  it('keeps a tilde-fenced example as text too', () => {
    const guard = new ToolMarkupGuard();
    const text = 'Shape:\n~~~\n<tool_call>{"name": "get_event", "arguments": {}}</tool_call>\n~~~\nDone.';
    const shown = guard.push(text);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toEqual({ status: 'clean' });
  });
});

describe('ToolMarkupGuard prose that only talks about markup', () => {
  it('keeps an answer that names a tag inside inline code, whole and clean', () => {
    const guard = new ToolMarkupGuard();
    const text = 'Wrap the value in the `<parameter>` tag and save the file.';
    const shown = guard.push(text);
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toEqual({ status: 'clean' });
  });

  it('keeps that answer whole when the inline code streams in split pieces', () => {
    const guard = new ToolMarkupGuard();
    let shown = '';
    for (const piece of ['Wrap the value in the `<par', 'ameter>` tag', ' and save the file.']) {
      shown += guard.push(piece);
      expect(guard.inMarkup).toBe(false);
    }
    expect(shown + guard.heldText).toBe('Wrap the value in the `<parameter>` tag and save the file.');
    expect(guard.finish()).toEqual({ status: 'clean' });
  });

  it('keeps a bare parameter mention with no backticks as text too', () => {
    const guard = new ToolMarkupGuard();
    const text = 'Set it with <parameter name="title"> as the first tag inside the call.';
    const shown = guard.push(text);
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toEqual({ status: 'clean' });
  });

  it('keeps prose that names the invoke and tool_call elements as text', () => {
    const guard = new ToolMarkupGuard();
    const text = 'The <invoke> element carries one call, and each call sits in a <tool_call> element.';
    const shown = guard.push(text);
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toEqual({ status: 'clean' });
  });

  it('keeps a sentence that shows a bare invoke tag as an example, byte for byte', () => {
    const guard = new ToolMarkupGuard();
    const text = 'Use <invoke name="x"> to start a call.';
    const shown = guard.push(text);
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toEqual({ status: 'clean' });
  });

  it('keeps that sentence whole when it streams in pieces, split at the tag', () => {
    const guard = new ToolMarkupGuard();
    let shown = '';
    shown += guard.push('Use <invoke name="x">');
    shown += guard.push(' to start a call.');
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe('Use <invoke name="x"> to start a call.');
    expect(guard.finish()).toEqual({ status: 'clean' });
  });

  it('releases an invoke whose envelope never completes when the reply ends', () => {
    const guard = new ToolMarkupGuard();
    const text = 'It opens like <invoke name="create_event"><parameter name="title">Den';
    const shown = guard.push(text);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toEqual({ status: 'clean' });
  });

  it('still stops a lone invoke whose envelope completes, which is broken markup', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('<invoke name="create_event"><parameter name="title">Dentist</parameter></invoke>');
    expect(shown).toBe('');
    expect(guard.finish()).toEqual({ status: 'broken' });
  });

  it('keeps a [TOOL_CALLS] mention that no list follows as text', () => {
    const guard = new ToolMarkupGuard();
    const text = 'The reply opens with a [TOOL_CALLS] marker, written out in full, then explains itself.';
    const shown = guard.push(text);
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toEqual({ status: 'clean' });
  });

  it('still recovers a real call that follows an inline-code mention of the wrapper', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push(
      'Aside: `<tool_call>` is the wrapper. For real now: ' +
        '<tool_call>{"name": "get_event", "arguments": {"event_id": "evt-2"}}</tool_call>',
    );
    expect(shown).toContain('Aside:');
    expect(shown).not.toContain('evt-2');
    expect(guard.finish()).toEqual({
      status: 'recovered',
      calls: [{ name: 'get_event', arguments: { event_id: 'evt-2' } }],
    });
  });

  it('still stops a plain XML call attempt, which is broken markup', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('<tool_calls><invoke name="create_event"></invoke></tool_calls>');
    expect(shown).toBe('');
    expect(guard.finish()).toEqual({ status: 'broken' });
  });

  it('still recovers a Mistral list streamed through the guard', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Doing it now. [TOOL_CALLS] [{"name": "get_event", "arguments": {"event_id": "evt-1"}}]');
    expect(shown).toBe('Doing it now. ');
    expect(guard.finish()).toEqual({
      status: 'recovered',
      calls: [{ name: 'get_event', arguments: { event_id: 'evt-1' } }],
    });
  });

  it('does not let an unclosed backtick on one line hide a real leak on the next', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push(
      'A stray ` backtick sits on this line.\n<｜DSML｜invoke name="create_event"></｜DSML｜invoke>',
    );
    expect(shown).toBe('A stray ` backtick sits on this line.\n');
    expect(guard.finish()).toEqual({ status: 'recovered', calls: [{ name: 'create_event', arguments: {} }] });
  });
});

describe('parseToolMarkup', () => {
  it('rebuilds a DSML call, with JSON parameters parsed and string parameters kept as text', () => {
    const outcome = parseToolMarkup(DSML_CREATE);
    expect(outcome).toEqual({
      status: 'recovered',
      calls: [
        {
          name: 'create_event',
          arguments: {
            title: 'Dentist appointment',
            start: { date_time: '2026-10-27T14:30:00', time_zone: 'America/New_York' },
            attendees: [{ email: 'sam@example.com' }],
          },
        },
      ],
    });
  });

  it('rebuilds more than one DSML invoke', () => {
    const markup =
      '<｜DSML｜tool_calls>' +
      '<｜DSML｜invoke name="get_event"><｜DSML｜parameter name="event_id" string="true">evt-1</｜DSML｜parameter></｜DSML｜invoke>' +
      '<｜DSML｜invoke name="get_event"><｜DSML｜parameter name="event_id" string="true">evt-2</｜DSML｜parameter></｜DSML｜invoke>' +
      '</｜DSML｜tool_calls>';
    const outcome = parseToolMarkup(markup);
    expect(outcome.status).toBe('recovered');
    if (outcome.status === 'recovered') {
      expect(outcome.calls.map(call => call.arguments['event_id'])).toEqual(['evt-1', 'evt-2']);
    }
  });

  it('treats a DSML call with a half-formed JSON parameter as broken', () => {
    const markup =
      '<｜DSML｜tool_calls><｜DSML｜invoke name="create_event">' +
      '<｜DSML｜parameter name="start" string="false">{"date_time": "2026-10-27T14:3</｜DSML｜parameter>' +
      '</｜DSML｜invoke></｜DSML｜tool_calls>';
    expect(parseToolMarkup(markup)).toEqual({ status: 'broken' });
  });

  it('treats a truncated DSML call as broken', () => {
    const markup =
      '<｜DSML｜tool_calls><｜DSML｜invoke name="create_event"><｜DSML｜parameter name="title" string="true">Den';
    expect(parseToolMarkup(markup)).toEqual({ status: 'broken' });
  });

  it('never rebuilds a function_results block, even beside a well-formed call', () => {
    const markup = `${DSML_CREATE}<function_results>Event added with id evt-9.</function_results>`;
    expect(parseToolMarkup(markup)).toEqual({ status: 'broken' });
  });

  it('rebuilds a Hermes tool_call JSON block', () => {
    const markup =
      '<tool_call>{"name": "create_event", "arguments": {"title": "Dentist", "start": {"date_time": "2026-10-27T14:30:00"}}}</tool_call>';
    expect(parseToolMarkup(markup)).toEqual({
      status: 'recovered',
      calls: [
        {
          name: 'create_event',
          arguments: { title: 'Dentist', start: { date_time: '2026-10-27T14:30:00' } },
        },
      ],
    });
  });

  it('treats a Hermes block with broken JSON as broken', () => {
    expect(parseToolMarkup('<tool_call>{"name": "create_event", "arguments": {"title": </tool_call>')).toEqual({
      status: 'broken',
    });
  });

  it('rebuilds a Mistral [TOOL_CALLS] list', () => {
    const markup = '[TOOL_CALLS] [{"name": "get_event", "arguments": {"event_id": "evt-1"}}]';
    expect(parseToolMarkup(markup)).toEqual({
      status: 'recovered',
      calls: [{ name: 'get_event', arguments: { event_id: 'evt-1' } }],
    });
  });

  it('treats markup in an unknown shape as broken', () => {
    expect(parseToolMarkup('<tool_calls><invoke name="create_event"></invoke></tool_calls>')).toEqual({
      status: 'broken',
    });
  });
});
