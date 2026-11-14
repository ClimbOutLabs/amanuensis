import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { isCaldavToolName } from './toolContract';

/** Said after a reply goes through when the calendar does not send replies itself. */
export const CALDAV_NO_SCHEDULING_NOTE =
  'Your answer is saved in the calendar. Your calendar does not send replies itself, so the organizer was not told.';

/** Said with a new event, so the next call reuses the id the calendar gave instead of making one up. */
export const CALDAV_CREATED_ID_NOTE =
  'To read, change or delete this event later, pass this id exactly as written. Do not make up an id.';

/** Said when a call names an event by an id the calendar never gave out. */
export const CALDAV_UNKNOWN_ID_NOTE =
  'That is not an event id from the calendar. Call list_events or search_events to find the event, then pass the id it shows.';

const CreatedEventSchema = z.looseObject({ created: z.literal(true), id: z.string() });
const NoSchedulingSchema = z.looseObject({ scheduling: z.literal(false) });

/** The connector's wording when an id does not decode to anything it hands out. */
const UNKNOWN_ID_TEXT = 'is not an id this server issued';

function resultText(result: CallToolResult): string {
  return result.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n');
}

function withNote({ result, note }: { result: CallToolResult; note: string }): CallToolResult {
  return {
    ...result,
    content: [...result.content, { type: 'text', text: note }],
    ...(result.structuredContent === undefined ? {} : { structuredContent: { ...result.structuredContent, note } }),
  };
}

/**
 * A CalDAV result as the model should read it. The model reads the structured result when there is
 * one, so a note goes there as well as into the text. A new event drops its iCalendar uid: no tool
 * takes it, and it looks enough like an id that the model passed it back as one.
 */
export function caldavResultForModel({
  tool_name,
  result,
}: {
  tool_name: string;
  result: CallToolResult;
}): CallToolResult {
  if (!isCaldavToolName(tool_name)) {
    return result;
  }
  if (result.isError === true) {
    if (!resultText(result).includes(UNKNOWN_ID_TEXT)) {
      return result;
    }
    return { ...result, content: [{ type: 'text', text: CALDAV_UNKNOWN_ID_NOTE }] };
  }
  if (tool_name === 'create_event') {
    const created = CreatedEventSchema.safeParse(result.structuredContent);
    if (!created.success) {
      return result;
    }
    const shaped = {
      ...Object.fromEntries(Object.entries(created.data).filter(([key]) => key !== 'uid')),
      note: CALDAV_CREATED_ID_NOTE,
    };
    return { ...result, content: [{ type: 'text', text: JSON.stringify(shaped, null, 2) }], structuredContent: shaped };
  }
  if (tool_name === 'respond_to_event' && NoSchedulingSchema.safeParse(result.structuredContent).success) {
    return withNote({ result, note: CALDAV_NO_SCHEDULING_NOTE });
  }
  return result;
}
