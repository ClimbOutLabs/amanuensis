# Amanuensis

Agent server and chat UI, started with one command. No clone, no database to set up. Login is mandatory, so
you point it at an OIDC identity provider first (see [Login](#login)).

```sh
npx amanuensis
```

Then open the URL it prints, by default <http://localhost:8790>.

## Options

```
npx amanuensis --port <n>   HTTP port (default 8790, or the PORT env var)
npx amanuensis --help       Show usage
```

Requires Node.js 22.14 or newer.

## Login

Amanuensis always requires sign-in and refuses to start without it. Set these before the first run:

```sh
export OIDC_ISSUER_URL=https://login.example.com/dex   # http is accepted only for localhost, 127.0.0.1, ::1
export OIDC_CLIENT_ID=<client id>
export OIDC_CLIENT_SECRET=<client secret>
```

Register `<public url>/api/v1/auth/callback` as the redirect URI, where the public URL is
`http://localhost:8790` unless you set `PUBLIC_BASE_URL` (an origin with no path; use `https` behind a
reverse proxy). To limit sign-in to one account, also set `OIDC_USER_ROLE_CLAIM=email`,
`OIDC_ADMIN_ROLE_VALUE=<email>` and `OIDC_ALLOWED_EMAILS=<email>`. Running several instances on one
hostname? Give each its own `AUTH_COOKIE_SUFFIX`. From a repository checkout, `pnpm dev:login` starts a
local Dex in Docker and prints these lines. See the authentication docs for details.

## First run: pick a model provider

Amanuensis ships no model credentials and calls no provider until you give it one. On first run,
open the UI, go to Settings, add a model provider with its API key, and select a model. Until you
do, there is nothing for a chat to talk to. Keys are stored in the local database described below
and are never sent anywhere except to the provider you chose.

## Where your data lives

The SQLite database defaults to `~/.amanuensis/db/db.sqlite` (`%USERPROFILE%\.amanuensis\db\db.sqlite`
on Windows). It holds your chats, agents, connectors, and provider credentials. Back up or delete
that directory to back up or reset Amanuensis.

Set `SQLITE_PATH` to put the database somewhere else:

```sh
SQLITE_PATH=/data/amanuensis.sqlite npx amanuensis
```

Sandbox working directories are created under the operating system's own application data
directory rather than `~/.amanuensis`, because the server resolves them from a platform data path
that has no environment override.

## Standalone only

`npx amanuensis` runs in standalone mode: SQLite, no Redis. That is local use only and
is not production-safe. It is a single process with no peering, so it cannot be scaled across
replicas, and it has no backup or migration story beyond copying the database file.

For a multi-replica deployment, run the server with `STANDALONE=false` against Postgres and Redis.

## What this package is

A thin wrapper. It carries the server, the compiled UI, and the database migrations in one
tarball so `npx` needs nothing else. The server itself is developed in this repository's
`packages/trueforge`, a fork of TrueForge, and is rebuilt into this package on every release.
