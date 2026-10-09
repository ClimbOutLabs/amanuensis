# Spec: Calendar MCP Integrations (Google, Outlook, iCal)

## Problem

Aman currently has Gmail MCP for email. But for a personal AI assistant to be useful with appointments, schedules, and smart departure times, it needs calendar access. Google Calendar is the most widely used. Outlook and iCal cover other users.

## Solution

Build MCP servers for Google Calendar, Outlook Calendar, and iCal (ICS) following the same pattern as the existing Gmail MCP.

## Integrations

### 1. Google Calendar (priority)

- OAuth2 flow (same pattern as Gmail MCP)
- Read events, create events, update/delete
- The user's primary calendar

### 2. Outlook Calendar

- Microsoft Graph API
- OAuth2
- Read/create/update/delete

### 3. iCal (ICS)

- Subscribe to ICS feed URLs
- Read-only (ICS is a subscription format)
- Covers Apple Calendar, etc.

## Design Principles (from feature #3: Privacy-safe MCP)

- Masked secrets (OAuth tokens never shown in UI)
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

- CalDAV (can be added later if needed)
- Shared calendar management
- Meeting scheduling assistant (separate feature)
