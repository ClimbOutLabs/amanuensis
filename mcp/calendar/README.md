# Calendar MCP

A self-hosted [Model Context Protocol](https://modelcontextprotocol.io) server that lets an
AI agent work with Google Calendar. Three tools, minimal OAuth scopes, Docker-ready.

| Tool | What it does | Needs scope |
| --- | --- | --- |
| `list_events` | List events in a time range (defaults to the next 7 days) | `calendar.readonly` |
| `create_event` | Create an event (title, start, end, optional description/location) | `calendar.events` |
| `delete_event` | Delete an event by ID | `calendar.events` |

OAuth requests only `calendar.readonly` + `calendar.events`. The broader `calendar` scope
(full calendar management) is never requested. Tools the granted scopes do not cover are
refused at call time.

## Setup

Node.js 20.6 or newer is required.

```bash
cd mcp/calendar
pnpm install
pnpm run build
```

### 1. Create a Google OAuth client

1. Create a Google Cloud project and enable the **Google Calendar API**.
2. Create an OAuth client (Desktop type is simplest). Add
   `http://localhost:3000/oauth2callback` as an authorized redirect URI.
3. Download the client JSON and save it as `~/.calendar-mcp/gcp-oauth.keys.json`
   (or set `CALENDAR_OAUTH_KEYS_PATH` to its location).

### 2. Authenticate

```bash
node dist/index.js auth
```

This opens the Google consent screen in your browser, requests the minimal scopes
(`calendar.readonly`, `calendar.events`), and writes tokens to
`~/.calendar-mcp/credentials.json` (mode 0600). For a headless machine, use `auth --headless`
and open the printed URL yourself, or authenticate on a laptop and copy the credentials file.

### 3. Serve MCP

Stdio (for local MCP hosts):

```bash
node dist/index.js mcp
```

Streamable HTTP (for remote hosts like TrueForge):

```bash
node dist/index.js mcp --http --port 8080
```

In HTTP mode the server holds no Google credentials. The MCP client completes Google OAuth
on the user's behalf and forwards the Google access token as the HTTP bearer token
(`Authorization: Bearer <token>`). The server validates the token against Google's
tokeninfo endpoint on every request (cached by token hash), derives the granted scopes,
and enforces them per tool. The server publishes OAuth protected-resource metadata at
`/.well-known/oauth-protected-resource` so the client can discover the authorization
server and supported scopes.

### 4. Docker

```bash
docker build -t calendar-mcp:1.0.0 mcp/calendar
docker run -d --name calendar-mcp -p 8080:8080 calendar-mcp:1.0.0
```

The HTTP transport needs no secrets: it validates the forwarded Google access token per
request. The volume and credential env vars below are only for the stdio transport
(`node dist/index.js mcp`), which uses local OAuth credentials.

Mount a volume at `/calendar-server` so credentials survive restarts. Alternatively, inject
credentials without a volume:

- `CALENDAR_CREDENTIALS_JSON`: raw `{tokens, scopes}` JSON (good for secret managers).
- `CALENDAR_CREDENTIALS_OP`: 1Password reference, e.g. `op://Personal/calendar-mcp/credentials`.
- `CALENDAR_CREDENTIALS_PATH`: explicit credentials file path.

Rotated access tokens are written back only when credentials were loaded from a file; env and
1Password sources remain read-only.

### 5. Register in TrueForge

Under **Settings → Connectors**, add the calendar server from the catalog. TrueForge performs
Google OAuth with your client credentials (stored as `${env:...}` / `${file:...}` references,
resolved at use time and never persisted in the clear), stores the tokens, and forwards the
access token to this server as the HTTP bearer token. The server validates the token and
enforces the scopes Google granted.

## Data flow

This section states exactly what data leaves the machine and where it goes.

- **Google Calendar API** (`https://www.googleapis.com`): event titles, times, descriptions,
  and locations flow to Google when tools run, and event data flows back.
- **Google OAuth** (`https://oauth2.googleapis.com`, `https://accounts.google.com`): in stdio
  mode, the authorization code exchange and token refreshes. Only OAuth tokens and the
  requested scope list travel here, never calendar content. In HTTP mode the MCP client
  (TrueForge) talks to these endpoints; the server only calls the tokeninfo endpoint to
  validate the forwarded bearer token.
- **MCP transport**: the agent host (e.g. TrueForge) connects over stdio or HTTP. Tool
  arguments and results pass through this channel. Over HTTP, requests carry the user's
  Google access token as the bearer token (validated per request, cached by token hash);
  use TLS termination (reverse proxy) in front of the container if the traffic crosses
  a network.
- **Local disk**: in stdio mode, OAuth tokens live in `<configDir>/credentials.json` (0600).
  The Google OAuth client keys (`gcp-oauth.keys.json`) are read once during `auth` and never
  leave the machine. In HTTP mode the server persists no credentials.

No analytics, no telemetry, no other third parties.

## Scope reference

| Shorthand | Google scope | Grants |
| --- | --- | --- |
| `calendar.readonly` | `https://www.googleapis.com/auth/calendar.readonly` | Read calendars and events |
| `calendar.events` | `https://www.googleapis.com/auth/calendar.events` | Read and write events |
| `calendar` | `https://www.googleapis.com/auth/calendar` | Full calendar access (never requested by default) |

If the stored credentials carry no scope list (older credentials), the server enforces
read-only until credentials with an explicit scope list are loaded.
