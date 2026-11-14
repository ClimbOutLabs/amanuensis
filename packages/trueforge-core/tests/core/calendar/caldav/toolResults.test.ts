import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  CALDAV_CREATED_ID_NOTE,
  CALDAV_NO_SCHEDULING_NOTE,
  CALDAV_UNKNOWN_ID_NOTE,
  caldavResultForModel,
} from '../../../../src/core/calendar/caldav/toolResults';

const EVENT_ID = 'e1.L2NhbGVuZGFycy9ob21lLw.ZXZlbnQtMS5pY3M';

function structured(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

describe('caldavResultForModel', () => {
  describe('a new event', () => {
    const created = structured({
      created: true,
      id: EVENT_ID,
      uid: '00000000-0000-4000-8000-000000000001@caldav-mcp',
      calendar: '/calendars/home/',
      etag: '"etag-1"',
    });

    it('keeps the id the calendar gave and tells the model to reuse it', () => {
      const shaped = caldavResultForModel({ tool_name: 'create_event', result: created });
      expect(shaped.structuredContent).toEqual({
        created: true,
        id: EVENT_ID,
        calendar: '/calendars/home/',
        etag: '"etag-1"',
        note: CALDAV_CREATED_ID_NOTE,
      });
    });

    it('drops the uid, which no tool takes, from what the model reads', () => {
      const shaped = caldavResultForModel({ tool_name: 'create_event', result: created });
      const text = shaped.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n');
      expect(text).toContain(EVENT_ID);
      expect(text).not.toContain('@caldav-mcp');
      expect(shaped.structuredContent).not.toHaveProperty('uid');
    });

    it('leaves an answer it does not recognise as it was', () => {
      const odd = structured({ created: true });
      expect(caldavResultForModel({ tool_name: 'create_event', result: odd })).toBe(odd);
    });
  });

  describe('an id the calendar never gave out', () => {
    const refused: CallToolResult = {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            'caldav-mcp: "made-up@caldav-mcp" is not an id this server issued. Ids come from the listing ' +
            'tools — list_events, list_tasks, list_journals — and are not meant to be composed by hand.',
        },
      ],
    };

    it.each(['get_event', 'update_event', 'delete_event', 'respond_to_event'])(
      'points %s to the listing tools in one line',
      tool_name => {
        expect(caldavResultForModel({ tool_name, result: refused })).toEqual({
          isError: true,
          content: [{ type: 'text', text: CALDAV_UNKNOWN_ID_NOTE }],
        });
      },
    );

    it('leaves other errors as the calendar wrote them', () => {
      const other: CallToolResult = { isError: true, content: [{ type: 'text', text: 'The calendar is busy.' }] };
      expect(caldavResultForModel({ tool_name: 'get_event', result: other })).toBe(other);
    });
  });

  describe('a reply to an invitation', () => {
    it('says the organizer was not told when the calendar sends no replies itself', () => {
      const shaped = caldavResultForModel({
        tool_name: 'respond_to_event',
        result: structured({ responded: true, id: EVENT_ID, scheduling: false }),
      });
      expect(shaped.structuredContent).toMatchObject({ note: CALDAV_NO_SCHEDULING_NOTE });
      expect(shaped.content.at(-1)).toEqual({ type: 'text', text: CALDAV_NO_SCHEDULING_NOTE });
    });

    it('adds nothing when the calendar sent the reply', () => {
      const sent = structured({ responded: true, id: EVENT_ID, scheduling: true });
      expect(caldavResultForModel({ tool_name: 'respond_to_event', result: sent })).toBe(sent);
    });
  });

  it('leaves tools from other connectors alone', () => {
    const other = structured({ created: true, id: 'x', uid: 'y' });
    expect(caldavResultForModel({ tool_name: 'create_note', result: other })).toBe(other);
  });
});
