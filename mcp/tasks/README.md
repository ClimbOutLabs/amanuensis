# Tasks MCP

A self-hosted [Model Context Protocol](https://modelcontextprotocol.io) server that lets an
AI agent work with Google Tasks. Five tools, minimal OAuth scopes, Docker-ready.

| Tool | What it does | Needs scope |
| --- | --- | --- |
| `list_tasks` | List tasks (completed hidden by default), optional due-date filters | `tasks.readonly` |
| `list_task_lists` | List the user's task lists | `tasks.readonly` |
| `create_task` | Create a task with title, notes, and due date | `tasks` |
| `complete_task` | Mark a task complete by ID | `tasks` |
| `delete_task` | Delete a task by ID | `tasks` |

OAuth requests only `tasks.readonly` + `tasks` (Google Tasks has no narrower write scope).
Tools the granted scopes do not cover are refused at call time.

## Setup

Node.js 20.6 or newer is required.

```bash
cd mcp/tasks
pnpm install
pnpm run build
```

### 1. Create a Google OAuth client

1. Create a Google Cloud project and enable the **Google Tasks API**.
2. Create an OAuth client (Desktop type is simplest). Add
   `http://localhost:3000/oauth2callback` as an authorized redirect URI.
3. Download the client JSON and save it as `~/.tasks-mcp/gcp-oauth.keys.json`
   (or set `TASKS_OAUTH_KEYS_PATH` to its location).

### 2. Authenticate

```bash
node dist/index.js auth
```

This opens the Google consent screen in your browser, requests the minimal scopes
(`tasks.readonly`, `tasks`), and writes tokens to
`~/.tasks-mcp/credentials.json` (mode 0600). For a headless machine, use `auth --headless`
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
docker build -t tasks-mcp:1.0.0 mcp/tasks
docker run -d --name tasks-mcp -p 8080:8080 \
  -v tasks-data:/tasks-server \
  tasks-mcp:1.0.0
```

Mount a volume at `/tasks-server` so credentials survive restarts. Alternatively, inject
credentials without a volume:

- `TASKS_CREDENTIALS_JSON`: raw `{tokens, scopes}` JSON (good for secret managers).
- `TASKS_CREDENTIALS_OP`: 1Password reference, e.g. `op://Personal/tasks-mcp/credentials`.
- `TASKS_CREDENTIALS_PATH`: explicit credentials file path.

Rotated access tokens are written back only when credentials were loaded from a file; env and
1Password sources remain read-only.

### 5. Register in TrueForge

Under **Settings → Connectors**, add the tasks server from the catalog. TrueForge performs
Google OAuth with your client credentials (stored as `${env:...}` / `${file:...}` references,
resolved at use time and never persisted in the clear), stores the tokens, and forwards the
access token to this server as the HTTP bearer token. The server validates the token and
enforces the scopes Google granted.

## Data flow

This section states exactly what data leaves the machine and where it goes.

- **Google Tasks API** (`https://www.googleapis.com`): task titles, notes, and due dates
  flow to Google when tools run, and task data flows back.
- **Google OAuth** (`https://oauth2.googleapis.com`, `https://accounts.google.com`): in stdio
  mode, the authorization code exchange and token refreshes. Only OAuth tokens and the
  requested scope list travel here, never task content. In HTTP mode the MCP client
  (TrueForge) talks to these endpoints; the server only calls the tokeninfo endpoint to
  validate the forwarded bearer token.
- **MCP transport**: the agent host (e.g. TrueForge) connects over stdio or HTTP. Tool
  arguments and results pass through this channel. Over HTTP, requests carry the user
's Google access token in the Authorization header (validated per request, cached by
  token hash); use TLS termination (reverse proxy) in front of the container if the
  traffic crosses a network.
- **Local disk**: in stdio mode, OAuth tokens live in `<configDir>/credentials.json` (0600).
  The Google OAuth client keys (`gcp-oauth.keys.json`) are read once during `auth` and never
  leave the machine. In HTTP mode the server persists no credentials.

No analytics, no telemetry, no other third parties.

## Scope reference

| Shorthand | Google scope | Grants |
| --- | --- | --- |
| `tasks.readonly` | `https://www.googleapis.com/auth/tasks.readonly` | Read task lists and tasks |
| `tasks` | `https://www.googleapis.com/auth/tasks` | Read and write task lists and tasks |

If the stored credentials carry no scope list (older credentials), the server enforces
read-only until credentials with an explicit scope list are loaded.
