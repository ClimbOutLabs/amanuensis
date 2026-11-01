/**
 * Leaked tool-call markup: the streaming filter never releases markup text, and no markup is ever run.
 */
import { ToolMarkupGuard } from '../../../src/core/llm/toolMarkup';

describe('ToolMarkupGuard streaming filter', () => {
  it('passes ordinary text through, holding back only a possible opener tail', () => {
    const guard = new ToolMarkupGuard();
    expect(guard.push('Hello there. ')).toBe('Hello there. ');
    expect(guard.push('a < b and c > d')).toBe('a < b and c > d');
    expect(guard.inMarkup).toBe(false);
    expect(guard.finish()).toBe('clean');
  });

  it('holds a partial opener until the next piece settles it', () => {
    const guard = new ToolMarkupGuard();
    // The piece ends mid-tag: nothing after the last safe character may be released yet.
    expect(guard.push('Working on it <')).toBe('Working on it ');
    expect(guard.push('b>not markup</b>')).toBe('<b>not markup</b>');
    expect(guard.finish()).toBe('clean');
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
    expect(guard.finish()).toBe('leaked');
  });

  it('never releases a function_results block', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Checking now. <function_results>The event was added.</function_results> All done.');
    expect(shown).toBe('Checking now. ');
    expect(guard.finish()).toBe('leaked');
  });

  it('keeps markup shown as an example inside a fenced code block as text', () => {
    const guard = new ToolMarkupGuard();
    const text =
      'Here is what the markup looks like:\n```\n<tool_call>{"name": "get_event", "arguments": {"event_id": "evt-1"}}</tool_call>\n```\nThat is the whole shape.';
    const shown = guard.push(text);
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toBe('clean');
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
    expect(guard.finish()).toBe('clean');
  });

  it('still holds back markup that comes after a fenced example closes', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push(
      'Example:\n```\n<tool_call>{"name": "get_event", "arguments": {"event_id": "evt-1"}}</tool_call>\n```\nNow for real: ' +
        '<tool_call>{"name": "get_event", "arguments": {"event_id": "evt-2"}}</tool_call>',
    );
    expect(shown).toContain('evt-1');
    expect(shown).not.toContain('evt-2');
    expect(guard.finish()).toBe('leaked');
  });

  it('keeps a tilde-fenced example as text too', () => {
    const guard = new ToolMarkupGuard();
    const text = 'Shape:\n~~~\n<tool_call>{"name": "get_event", "arguments": {}}</tool_call>\n~~~\nDone.';
    const shown = guard.push(text);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toBe('clean');
  });
});

describe('ToolMarkupGuard prose that only talks about markup', () => {
  it('keeps an answer that names a tag inside inline code, whole and clean', () => {
    const guard = new ToolMarkupGuard();
    const text = 'Wrap the value in the `<parameter>` tag and save the file.';
    const shown = guard.push(text);
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toBe('clean');
  });

  it('keeps that answer whole when the inline code streams in split pieces', () => {
    const guard = new ToolMarkupGuard();
    let shown = '';
    for (const piece of ['Wrap the value in the `<par', 'ameter>` tag', ' and save the file.']) {
      shown += guard.push(piece);
      expect(guard.inMarkup).toBe(false);
    }
    expect(shown + guard.heldText).toBe('Wrap the value in the `<parameter>` tag and save the file.');
    expect(guard.finish()).toBe('clean');
  });

  it('keeps a bare parameter mention with no backticks as text too', () => {
    const guard = new ToolMarkupGuard();
    const text = 'Set it with <parameter name="title"> as the first tag inside the call.';
    const shown = guard.push(text);
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toBe('clean');
  });

  it('keeps prose that names the invoke and tool_call elements as text', () => {
    const guard = new ToolMarkupGuard();
    const text = 'The <invoke> element carries one call, and each call sits in a <tool_call> element.';
    const shown = guard.push(text);
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toBe('clean');
  });

  it('keeps a sentence that shows a bare invoke tag as an example, byte for byte', () => {
    const guard = new ToolMarkupGuard();
    const text = 'Use <invoke name="x"> to start a call.';
    const shown = guard.push(text);
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toBe('clean');
  });

  it('keeps that sentence whole when it streams in pieces, split at the tag', () => {
    const guard = new ToolMarkupGuard();
    let shown = '';
    shown += guard.push('Use <invoke name="x">');
    shown += guard.push(' to start a call.');
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe('Use <invoke name="x"> to start a call.');
    expect(guard.finish()).toBe('clean');
  });

  it('releases an invoke whose envelope never completes when the reply ends', () => {
    const guard = new ToolMarkupGuard();
    const text = 'It opens like <invoke name="create_event"><parameter name="title">Den';
    const shown = guard.push(text);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toBe('clean');
  });

  it('holds back a lone invoke whose envelope completes as leaked markup', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('<invoke name="create_event"><parameter name="title">Dentist</parameter></invoke>');
    expect(shown).toBe('');
    expect(guard.finish()).toBe('leaked');
  });

  it('keeps a [TOOL_CALLS] mention that no list follows as text', () => {
    const guard = new ToolMarkupGuard();
    const text = 'The reply opens with a [TOOL_CALLS] marker, written out in full, then explains itself.';
    const shown = guard.push(text);
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toBe('clean');
  });

  it('holds back a real call that follows an inline-code mention of the wrapper', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push(
      'Aside: `<tool_call>` is the wrapper. For real now: ' +
        '<tool_call>{"name": "get_event", "arguments": {"event_id": "evt-2"}}</tool_call>',
    );
    expect(shown).toContain('Aside:');
    expect(shown).not.toContain('evt-2');
    expect(guard.finish()).toBe('leaked');
  });

  it('holds back a plain XML call attempt as leaked markup', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('<tool_calls><invoke name="create_event"></invoke></tool_calls>');
    expect(shown).toBe('');
    expect(guard.finish()).toBe('leaked');
  });

  it('holds back a Mistral list streamed through the guard', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Doing it now. [TOOL_CALLS] [{"name": "get_event", "arguments": {"event_id": "evt-1"}}]');
    expect(shown).toBe('Doing it now. ');
    expect(guard.finish()).toBe('leaked');
  });

  it('does not let an unclosed backtick on one line hide a real leak on the next', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push(
      'A stray ` backtick sits on this line.\n<｜DSML｜invoke name="create_event"></｜DSML｜invoke>',
    );
    expect(shown).toBe('A stray ` backtick sits on this line.\n');
    expect(guard.finish()).toBe('leaked');
  });
});

describe('ToolMarkupGuard prose naming the strong tags', () => {
  it('hides a closing results tag named in a sentence, since a closing tag outside code is always stray', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('The closing tag </function_results> ends the block.');
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe('The closing tag  ends the block.');
    expect(guard.finish()).toBe('clean');
  });

  it('hides that tag the same way when it streams in pieces, split inside the tag', () => {
    const guard = new ToolMarkupGuard();
    let shown = '';
    shown += guard.push('The closing tag </function_res');
    shown += guard.push('ults> ends the block.');
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe('The closing tag  ends the block.');
    expect(guard.finish()).toBe('clean');
  });

  it('keeps prose that names the DSML marker with no call shape around it as text', () => {
    const guard = new ToolMarkupGuard();
    const text = 'The marker <｜DSML｜ opens a call block in that format.';
    const shown = guard.push(text);
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toBe('clean');
  });

  it('keeps that prose whole when the marker streams in split pieces', () => {
    const guard = new ToolMarkupGuard();
    let shown = '';
    shown += guard.push('The marker <｜DS');
    shown += guard.push('ML｜ opens a call block in that format.');
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe('The marker <｜DSML｜ opens a call block in that format.');
    expect(guard.finish()).toBe('clean');
  });

  it('keeps prose that names the DSML wrapper as text', () => {
    const guard = new ToolMarkupGuard();
    const text = 'The <｜DSML｜tool_calls> wrapper holds the calls in that format.';
    const shown = guard.push(text);
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toBe('clean');
  });

  it('keeps prose that names the results block with no closing tag as text', () => {
    const guard = new ToolMarkupGuard();
    const text = 'A <function_results> block holds results the model made up.';
    const shown = guard.push(text);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toBe('clean');
  });

  it('never releases a results block streamed in pieces', () => {
    const guard = new ToolMarkupGuard();
    let shown = '';
    shown += guard.push('Checking now. <function_res');
    shown += guard.push('ults>The event was added.</function_results> All done.');
    expect(shown).toBe('Checking now. ');
    expect(guard.finish()).toBe('leaked');
  });

  it('releases a prose invoke example and still captures the real DSML call after it, in one piece', () => {
    const guard = new ToolMarkupGuard();
    const text =
      'Use <invoke name="x"> to start a call. Now: ' +
      '<｜DSML｜invoke name="create_event"><｜DSML｜parameter name="title" string="true">Dentist</｜DSML｜parameter></｜DSML｜invoke>';
    const shown = guard.push(text);
    expect(shown).toBe('Use <invoke name="x"> to start a call. Now: ');
    expect(guard.finish()).toBe('leaked');
  });
});

describe('ToolMarkupGuard indented code blocks', () => {
  const ENVELOPE = '<invoke name="create_event"><parameter name="title">Dentist</parameter></invoke>';

  it('keeps a complete envelope inside an indented code block as text', () => {
    const guard = new ToolMarkupGuard();
    const text = `Review:\n\n    ${ENVELOPE}`;
    const shown = guard.push(text);
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toBe('clean');
  });

  it('keeps it whole when the block streams in pieces, split inside the envelope', () => {
    const guard = new ToolMarkupGuard();
    let shown = '';
    shown += guard.push('Review:\n\n    <invoke name="cre');
    expect(guard.inMarkup).toBe(false);
    shown += guard.push('ate_event"><parameter name="title">Dentist</parameter></invoke>');
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(`Review:\n\n    ${ENVELOPE}`);
    expect(guard.finish()).toBe('clean');
  });

  it('keeps it whole when the split falls inside the indentation', () => {
    const guard = new ToolMarkupGuard();
    let shown = '';
    shown += guard.push('Review:\n\n  ');
    shown += guard.push('  ');
    shown += guard.push(ENVELOPE);
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(`Review:\n\n    ${ENVELOPE}`);
    expect(guard.finish()).toBe('clean');
  });

  it('still holds back a genuine envelope after the indented block ends', () => {
    const guard = new ToolMarkupGuard();
    const text = `Review:\n\n    <invoke name="x">an example</invoke>\n\nFor real: ${ENVELOPE}`;
    const shown = guard.push(text);
    expect(shown).toBe('Review:\n\n    <invoke name="x">an example</invoke>\n\nFor real: ');
    expect(guard.finish()).toBe('leaked');
  });

  it('streams an indented block followed by ordinary prose whole', () => {
    const guard = new ToolMarkupGuard();
    const text = 'Snippet:\n\n    total = 0\n    total += 1\n\nThat adds one.';
    const shown = guard.push(text);
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toBe('clean');
  });

  it('does not treat a two-space indent as a code block', () => {
    const guard = new ToolMarkupGuard();
    const text = `Review:\n\n  ${ENVELOPE}`;
    const shown = guard.push(text);
    expect(shown).toBe('Review:\n\n  ');
    expect(guard.finish()).toBe('leaked');
  });
});

describe('ToolMarkupGuard stray closing tags', () => {
  it('hides a closing tag with the next sentence glued straight to it', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Prior to that </tool_calls>Your errands are now on the calendar.');
    expect(shown + guard.heldText).toBe('Prior to that Your errands are now on the calendar.');
    expect(guard.finish()).toBe('clean');
  });

  it('hides a glued closing tag when the word after it arrives in the next piece', () => {
    const guard = new ToolMarkupGuard();
    let shown = '';
    for (const piece of ['Done. </tool_', 'calls>', 'Your errands are set.']) {
      shown += guard.push(piece);
    }
    expect(shown + guard.heldText).toBe('Done. Your errands are set.');
    expect(guard.finish()).toBe('clean');
  });

  it.each(['**Done**', '(done)', '😀 done', '“Done”'])('hides a closing tag with %s glued to it', after => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push(`Okay </tool_calls>${after} and set.`);
    expect(shown + guard.heldText).toBe(`Okay ${after} and set.`);
    expect(guard.finish()).toBe('clean');
  });

  it('hides a closing tag before closing punctuation', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('A call ends with </invoke>. Then the reply goes on.');
    expect(shown + guard.heldText).toBe('A call ends with . Then the reply goes on.');
    expect(guard.finish()).toBe('clean');
  });

  it.each(['"Your errands" are set.', "'Your errands' are set.", '`x` set.', ' and nothing else.'])(
    'hides a closing tag with %s after it',
    after => {
      const guard = new ToolMarkupGuard();
      const shown = guard.push(`Okay </tool_calls>${after}`);
      expect(shown + guard.heldText).toBe(`Okay ${after}`);
      expect(guard.finish()).toBe('clean');
    },
  );

  it('keeps a closing tag that a sentence names in code', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('The block ends with `</tool_calls>` and nothing else.');
    expect(shown + guard.heldText).toBe('The block ends with `</tool_calls>` and nothing else.');
    expect(guard.finish()).toBe('clean');
  });

  it('hides a stray closing tool-call line and keeps the answer around it', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Let me look.\n</tool_call>\nThe space is ready.');
    expect(shown).toBe('Let me look.\nThe space is ready.');
    expect(guard.finish()).toBe('clean');
  });

  it('hides a stray closing tag that streams in split pieces', () => {
    const guard = new ToolMarkupGuard();
    let shown = '';
    for (const piece of ['Let me look.\n</tool', '_call>\nNext.']) {
      shown += guard.push(piece);
    }
    expect(shown + guard.heldText).toBe('Let me look.\nNext.');
    expect(guard.finish()).toBe('clean');
  });

  it('hides a stray closing tag at the very end of the reply', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Done.\n</tool_call>');
    expect(guard.finish()).toBe('clean');
    expect(shown + guard.heldText).toBe('Done.\n');
  });

  it('hides a stray closing tag glued to the end of an answer line', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Done.</tool_call>\nMore text follows here.');
    expect(shown + guard.heldText).toBe('Done.\nMore text follows here.');
    expect(guard.finish()).toBe('clean');
  });

  it('drops a stray closing tag the reply ends on, after words on the same line', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Your visit is Monday at 2:30 pm.</tool_call>');
    expect(guard.finish()).toBe('clean');
    expect(shown + guard.heldText).toBe('Your visit is Monday at 2:30 pm.');
  });

  it('drops a stray closing tag followed only by spaces when the reply ends', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Done.</tool_call>  ');
    expect(guard.finish()).toBe('clean');
    expect(shown + guard.heldText).toBe('Done.');
  });

  it('drops a pair of stray closing tags the reply ends on', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Done.</tool_call></tool_calls>');
    expect(guard.finish()).toBe('clean');
    expect(shown + guard.heldText).toBe('Done.');
  });

  it('drops a spaced pair of stray closing tags the reply ends on', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Done.</tool_call> </tool_calls>');
    expect(guard.finish()).toBe('clean');
    expect(shown + guard.heldText).toBe('Done.');
  });

  it('drops a mixed pair of stray closing tags the reply ends on', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Done.</tool_call></invoke>');
    expect(guard.finish()).toBe('clean');
    expect(shown + guard.heldText).toBe('Done.');
  });

  it('hides a pair of stray closing tags alone on a line and keeps the answer around it', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Let me look.\n</tool_call></tool_calls>\nThe space is ready.');
    expect(shown).toBe('Let me look.\nThe space is ready.');
    expect(guard.finish()).toBe('clean');
  });

  it('hides a pair of stray closing tags glued to the end of an answer line', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Done.</tool_call></tool_calls>\nMore text follows here.');
    expect(shown + guard.heldText).toBe('Done.\nMore text follows here.');
    expect(guard.finish()).toBe('clean');
  });

  it('hides a pair of stray closing tags that streams in split pieces', () => {
    const guard = new ToolMarkupGuard();
    let shown = '';
    for (const piece of ['Done.</tool', '_call></to', 'ol_calls>\nNext.']) {
      shown += guard.push(piece);
    }
    expect(shown + guard.heldText).toBe('Done.\nNext.');
    expect(guard.finish()).toBe('clean');
  });

  it('hides a spaced pair of stray closing tags split inside the second tag', () => {
    const guard = new ToolMarkupGuard();
    let shown = '';
    for (const piece of ['Done.</tool_call> </to', 'ol_calls>']) {
      shown += guard.push(piece);
    }
    expect(guard.finish()).toBe('clean');
    expect(shown + guard.heldText).toBe('Done.');
  });

  it('hides a spaced pair of stray closing tags split inside both tags', () => {
    const guard = new ToolMarkupGuard();
    let shown = '';
    for (const piece of ['Done.</tool', '_call> </tool', '_calls>']) {
      shown += guard.push(piece);
    }
    expect(guard.finish()).toBe('clean');
    expect(shown + guard.heldText).toBe('Done.');
  });

  it('hides a closing tag with words after it on the line', () => {
    const guard = new ToolMarkupGuard();
    const sentence = 'End the block with </tool_call> and then stop.';
    expect(guard.push(sentence) + guard.heldText).toBe('End the block with  and then stop.');
    expect(guard.finish()).toBe('clean');
  });

  it('hides a closing tag inside a sentence', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Close the block with </tool_call> at the end.');
    expect(shown + guard.heldText).toBe('Close the block with  at the end.');
    expect(guard.finish()).toBe('clean');
  });

  it('hides a pair of closing tags inside a sentence', () => {
    const guard = new ToolMarkupGuard();
    const sentence = 'End the block with </tool_call></tool_calls> and then stop.';
    expect(guard.push(sentence) + guard.heldText).toBe('End the block with  and then stop.');
    expect(guard.finish()).toBe('clean');
  });

  it('holds back a wrapper with a closing tag and no call inside as leaked markup', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Before. <tool_call>not json</tool_call>');
    expect(shown).toBe('Before. ');
    expect(guard.finish()).toBe('leaked');
  });
});

describe('ToolMarkupGuard chat-template and function-name forms', () => {
  it('holds back a lone DSML parameter line, the shape the model wrote as text', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push(
      'Setting the reminder now.\n<｜DSML｜parameter name="start" string="true">2026-10-23T09:10</｜DSML｜parameter>\n',
    );
    expect(shown).toBe('Setting the reminder now.\n');
    expect(shown).not.toContain('DSML');
    expect(guard.finish()).toBe('leaked');
  });

  it('holds back the same parameter line when it streams in pieces', () => {
    const guard = new ToolMarkupGuard();
    const released = [
      'Ok. <｜DS',
      'ML｜parameter name="start"',
      ' string="true">2026',
      '-10-23T09:10</｜DSML｜parameter>',
    ].map(piece => guard.push(piece));
    expect(released.join('')).toBe('Ok. ');
    expect(guard.finish()).toBe('leaked');
  });

  it('holds back a complete chat-template token', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Calling it.<｜tool▁call▁begin｜>create_event');
    expect(shown).toBe('Calling it.');
    expect(guard.finish()).toBe('leaked');
  });

  it('holds back a function-name tag and its parameters', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Searching.\n<function=get_event>\n<parameter=event_id>evt-1</parameter>\n</function>');
    expect(shown).toBe('Searching.\n');
    expect(guard.finish()).toBe('leaked');
  });

  it('keeps a function-name tag named inside inline code as text', () => {
    const guard = new ToolMarkupGuard();
    const text = 'Write it as `<function=name>` when you name the call.';
    const shown = guard.push(text);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toBe('clean');
  });

  it('keeps prose that names the fullwidth bar as text', () => {
    const guard = new ToolMarkupGuard();
    const text = 'The fullwidth bar "<｜" opens a token name in the template.';
    const shown = guard.push(text);
    expect(shown + guard.heldText).toBe(text);
    expect(guard.finish()).toBe('clean');
  });
});

describe('ToolMarkupGuard plain parameter fragments', () => {
  it('holds back a lone plain parameter line, the shape a cut-off call leaves', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Here is what I found.\n<parameter name="query">dog breeds</parameter>\n');
    expect(shown).toBe('Here is what I found.\n');
    expect(guard.finish()).toBe('leaked');
  });

  it('holds back the same parameter line when it streams in pieces, split inside the tag', () => {
    const guard = new ToolMarkupGuard();
    let shown = '';
    shown += guard.push('Here is what I found.\n<par');
    expect(guard.inMarkup).toBe(false);
    shown += guard.push('ameter name="query">dog breeds</parameter>');
    expect(shown).toBe('Here is what I found.\n');
    expect(guard.finish()).toBe('leaked');
  });

  it('holds back a plain parameter line in the bare equals form, opening the reply', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('<parameter=event_id>evt-1</parameter>');
    expect(shown).toBe('');
    expect(guard.finish()).toBe('leaked');
  });

  it('settles the cut-off sub-agent shape with the fragments gone and the prose kept whole', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('Almost there. List ra\n<parameter name="breed">Labrador</parameter>\n</parameter>');
    expect(shown).toBe('Almost there. List ra\n');
    expect(guard.finish()).toBe('leaked');
  });

  it('hides an orphan plain parameter closing tag alone on its line', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('The list is ready.\n</parameter>\nAnything else?');
    expect(shown).toBe('The list is ready.\nAnything else?');
    expect(guard.finish()).toBe('clean');
  });

  it('drops a lone plain parameter closing tag the reply ends on', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('All set.\n</parameter>');
    expect(guard.finish()).toBe('clean');
    expect(shown + guard.heldText).toBe('All set.\n');
  });

  it('keeps a bare parameter mention inside a sentence as text when it streams in split pieces', () => {
    const guard = new ToolMarkupGuard();
    let shown = '';
    shown += guard.push('Set it with <par');
    shown += guard.push('ameter name="title"> as the first tag inside the call.');
    expect(guard.inMarkup).toBe(false);
    expect(shown + guard.heldText).toBe('Set it with <parameter name="title"> as the first tag inside the call.');
    expect(guard.finish()).toBe('clean');
  });

  it('hides a plain parameter closing tag inside a sentence', () => {
    const guard = new ToolMarkupGuard();
    const shown = guard.push('End the call with </parameter> and then stop.');
    expect(shown + guard.heldText).toBe('End the call with  and then stop.');
    expect(guard.finish()).toBe('clean');
  });
});
