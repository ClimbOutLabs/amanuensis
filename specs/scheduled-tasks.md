# Spec: Scheduled Tasks and Proactive Briefings

**Status:** draft

## Problem

Aman is reactive: it answers when asked and is silent otherwise. A personal AI assistant should handle reminders, run recurring research, and deliver a morning briefing that pulls together the calendar and memory without being asked.

## Solution

A task scheduler with per-task notification controls. Task types: one-shot reminders, recurring research jobs, and morning briefings.

## Design Decisions

**Tasks are user-created and user-owned.** Aman suggests tasks ("want a reminder before your flight?") but the user confirms. No silent background jobs the user did not approve.

**Morning briefing** assembles: today's calendar events (from calendar MCP), overnight memory additions, and any due reminders. Delivered at a user-configured time via the configured notification channel.

**Recurring research** runs a saved prompt on a schedule (e.g. "summarize AI hardware news every Monday"). Results land in the chat as a briefing card.

**Per-task notification controls.** Each task has its own channel (in-app, push, silent log) and quiet hours are global. A task can be paused, edited, or deleted at any time.

**A reminder lands where it was set.** When a reminder is set in a chat, that chat is recorded on the reminder. When the reminder fires, the bell item comes first, then its line appears at the end of that same chat, and the bell item opens that chat. The chat is recorded by the server when the reminder is set; the schedules API does not accept it, and an edit keeps it. The line is written only into a chat the reminder's owner started. If a reply is running in that chat, the line waits for it to end. There is no shared Reminders chat. A reminder set outside a chat, a reminder saved before this was recorded, and a reminder whose chat has been deleted still fire on time: the bell item carries them, with no chat line and no link, and no chat is made. Chats named Reminders that already exist in a person's data are left as they are.

**One place to see every reminder.** A Reminders button in the left panel opens a view of all the reminders a person set: "Coming up" (soonest first, paused ones marked) and "Already reminded" (newest first, including any whose time came and did not go through). Each row says what the reminder is for, when it is due or when it fired, which persona it was set with, and when it was set. The view is read-only; reminders are still set, changed and cancelled in chat. Rows link to the Reminders chat, the one chat every reminder is delivered into. The chat a reminder was originally set in is not recorded on the reminder, so no row pretends to lead there; recording it at set time is a separate change.

## Scope

- Create/edit/delete scheduled tasks from chat ("remind me in 2 hours", "brief me every morning at 7")
- One-shot reminders with natural language times
- Recurring tasks with cron-like schedules in plain language
- Morning briefing: calendar + memory + due reminders
- Per-task notification channel selection
- Global quiet hours
- Task list UI showing upcoming runs
- Reminders view in the left panel, served read-only by `GET /api/v1/user/reminders`, scoped to the person who set each reminder

## Privacy

- Task definitions and results stay on the device
- Briefing content is never sent to third parties

## Testing

- Synthetic reminders and briefings only
- Verify: "remind me in 5 minutes" fires on time
- Verify: morning briefing renders with synthetic calendar events
- Verify: quiet hours suppress notifications
- Verify: deleting a task stops all future runs

## Out of Scope

- Push notifications on mobile (deferred: needs backend event hooks, see PWA plan)
- Natural language schedule parsing beyond common patterns
- Sharing tasks across personas
