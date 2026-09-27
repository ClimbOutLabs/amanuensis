// SPDX-License-Identifier: Apache-2.0
// Copyright (c) ClimbOutLabs contributors.
// Google Calendar API operations backing the MCP tools.
//
// Each op takes an authenticated OAuth2Client and returns plain JSON-safe
// objects. Errors from the API surface as-is so the MCP tool layer can wrap
// them with tool context.

import { OAuth2Client } from "google-auth-library";
import { calendar_v3, google } from "googleapis";

export interface CalendarEventSummary {
  id?: string | null;
  summary?: string | null;
  description?: string | null;
  start?: { dateTime?: string | null; date?: string | null; timeZone?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null; timeZone?: string | null } | null;
  location?: string | null;
  htmlLink?: string | null;
  status?: string | null;
}

function toSummary(event: calendar_v3.Schema$Event): CalendarEventSummary {
  return {
    id: event.id,
    summary: event.summary,
    description: event.description,
    start: event.start
      ? { dateTime: event.start.dateTime, date: event.start.date, timeZone: event.start.timeZone }
      : null,
    end: event.end
      ? { dateTime: event.end.dateTime, date: event.end.date, timeZone: event.end.timeZone }
      : null,
    location: event.location,
    htmlLink: event.htmlLink,
    status: event.status,
  };
}

export interface ListEventsArgs {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
  query?: string;
}

/** List events in a time range. Defaults to "now → +7 days" on the primary calendar. */
export async function listEvents(
  auth: OAuth2Client,
  args: ListEventsArgs = {},
): Promise<CalendarEventSummary[]> {
  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();
  const res = await calendar.events.list({
    calendarId: args.calendarId ?? "primary",
    timeMin: args.timeMin ?? now.toISOString(),
    timeMax: args.timeMax ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    maxResults: args.maxResults ?? 25,
    singleEvents: true,
    orderBy: "startTime",
    ...(args.query ? { q: args.query } : {}),
  });
  return (res.data.items ?? []).map(toSummary);
}

export interface CreateEventArgs {
  calendarId?: string;
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  timeZone?: string;
}

/** Create an event. `start`/`end` accept RFC3339 date-times or YYYY-MM-DD dates. */
export async function createEvent(
  auth: OAuth2Client,
  args: CreateEventArgs,
): Promise<CalendarEventSummary> {
  const calendar = google.calendar({ version: "v3", auth });
  const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(args.start) && /^\d{4}-\d{2}-\d{2}$/.test(args.end);
  const res = await calendar.events.insert({
    calendarId: args.calendarId ?? "primary",
    requestBody: {
      summary: args.title,
      description: args.description,
      location: args.location,
      start: isAllDay ? { date: args.start, timeZone: args.timeZone } : { dateTime: args.start, timeZone: args.timeZone },
      end: isAllDay ? { date: args.end, timeZone: args.timeZone } : { dateTime: args.end, timeZone: args.timeZone },
    },
  });
  return toSummary(res.data);
}

export interface DeleteEventArgs {
  calendarId?: string;
  eventId: string;
}

/** Delete an event by id. */
export async function deleteEvent(auth: OAuth2Client, args: DeleteEventArgs): Promise<{ deleted: true; eventId: string }> {
  const calendar = google.calendar({ version: "v3", auth });
  await calendar.events.delete({
    calendarId: args.calendarId ?? "primary",
    eventId: args.eventId,
  });
  return { deleted: true, eventId: args.eventId };
}
