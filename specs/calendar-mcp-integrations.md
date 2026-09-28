# Spec: Calendar MCP Integrations (Google, Outlook, iCal)

## Problem
Aman currently has Gmail MCP for email. But for a personal AI assistant to be useful with appointments, schedules, and smart departure times, it needs calendar access. Google Calendar is the most widely used. Outlook and iCal cover other users.

## Solution
Integrate official MCP servers where they exist (Google, Microsoft). Build a CalDAV integration for Apple/iCloud, which has no official MCP server.

## Integrations

### 1. Google Calendar (priority)
- Integrate Google's official Calendar MCP server
- Read events, create events, update/delete
- The user's primary calendar

### 2. Outlook Calendar
- Integrate Microsoft's official Outlook Calendar MCP server (Agent 365)
- Uses Microsoft Graph API under the hood
- Read/create/update/delete

### 3. Apple Calendar / iCloud (CalDAV)
- Build a CalDAV integration (open standard, RFC 4791)
- Connects to `caldav.icloud.com` with Apple ID + app-specific password
- Read/write access to all iCloud calendars
- No official Apple MCP server exists; CalDAV is the practical path
- Also works with Fastmail, Nextcloud, and any CalDAV provider

## Design Principles (from feature #3: Privacy-safe MCP)
- Masked secrets (OAuth tokens and app-specific passwords never shown in UI)
- Per-integration permission scopes (user grants granular access)
- Each integration can be enabled/disabled independently
- Clear data-flow documentation

## Use Cases Enabled
- "What's on my calendar today?" (morning briefing, feature #2)
- Smart departure times (embedded maps phase 2)
- "Schedule a meeting with X tomorrow at 2pm"
- Proactive reminders before appointments

## Testing
- Synthetic calendar events (not real user calendar data)
- Verify: read, create, update, delete for each provider
- Verify: permission scopes are enforced
- Verify: disabling an integration revokes access cleanly

## Out of Scope
- Shared calendar management
- Meeting scheduling assistant (separate feature)
