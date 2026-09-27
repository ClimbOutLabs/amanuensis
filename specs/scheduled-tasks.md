# Spec: Scheduled Tasks and Proactive Briefings

## Problem
Aman is reactive: it answers when asked and is silent otherwise. A personal AI assistant should handle reminders, run recurring research, and deliver a morning briefing that pulls together the calendar and memory without being asked.

## Solution
A task scheduler with per-task notification controls. Task types: one-shot reminders, recurring research jobs, and morning briefings.

## Design Decisions

**Tasks are user-created and user-owned.** Aman suggests tasks ("want a reminder before your flight?") but the user confirms. No silent background jobs the user did not approve.

**Morning briefing** assembles: today's calendar events (from calendar MCP), overnight memory additions, and any due reminders. Delivered at a user-configured time via the configured notification channel.

**Recurring research** runs a saved prompt on a schedule (e.g. "summarize AI hardware news every Monday"). Results land in the chat as a briefing card.

**Per-task notification controls.** Each task has its own channel (in-app, push, silent log) and quiet hours are global. A task can be paused, edited, or deleted at any time.

## Scope
- Create/edit/delete scheduled tasks from chat ("remind me in 2 hours", "brief me every morning at 7")
- One-shot reminders with natural language times
- Recurring tasks with cron-like schedules in plain language
- Morning briefing: calendar + memory + due reminders
- Per-task notification channel selection
- Global quiet hours
- Task list UI showing upcoming runs

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
