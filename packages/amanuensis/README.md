# Amanuensis

Agent server and chat UI, started with one command. No clone, no database to set up.

```sh
npx amanuensis
```

Run `npx amanuensis`, open the address, create your sign-in. Then open the URL it prints, by default <http://localhost:8790>.

## Options

```
npx amanuensis --port <n>   HTTP port (default 8790, or the PORT env var)
npx amanuensis --reset-password   Set a new password for the local sign-in (Aman must be stopped)
npx amanuensis --help       Show usage
```

Requires Node.js 22.14 or newer.

## Sign-in

The first time you open Aman it asks you to create your sign-in: an email and a password of at least 8 characters, typed twice. Aman keeps the password itself, as a scrambled hash, in its own database. There is only ever one sign-in, and it can change every setting. After that first time, the same page is a plain sign-in form.

Change the password any time in Settings, Account. Changing it signs out every other device.

Forgot the password? There is no reset by email. Stop Aman, run `npx amanuensis --reset-password`, and type a new password twice on the terminal (it does not show what you type). Then start Aman again and sign in with the new password. The sign-in page carries the same instruction in one line.

Local sign-in works on this computer, or behind an https address you set as `PUBLIC_BASE_URL`. If a plain http address on another computer is listed, Aman refuses to start and says why: a password should not travel over an open connection.

### Advanced: your own sign-in service

If you would rather Aman use a sign-in service (OIDC) you run yourself, set these before the first run and the local sign-in stays off:

```sh
export OIDC_ISSUER_URL=https://login.example.com/dex   # your sign-in service; http only for localhost, 127.0.0.1, ::1
export OIDC_CLIENT_ID=<client id from the sign-in service>
export OIDC_CLIENT_SECRET=<client secret>
export OIDC_ALLOWED_EMAILS=<your email>                # exactly one address, no wildcard
```

Give the sign-in service `<public url>/api/v1/auth/callback` as the redirect address, where the public URL is `http://localhost:8790` unless you set `PUBLIC_BASE_URL` (an origin with no path; use `https` behind a reverse proxy). It refuses to start unless `OIDC_ALLOWED_EMAILS` holds exactly one address, and it accepts only sign-ins with a verified email. So that you can change server settings, also set `OIDC_USER_ROLE_CLAIM=email` and `OIDC_ADMIN_ROLE_VALUE=<your email>`. Running several instances on one hostname? Give each its own `AUTH_COOKIE_SUFFIX`. From a repository checkout, `pnpm dev:login` starts a local Dex in Docker and prints these lines. See the authentication docs for details.

## First run: pick a model provider

Amanuensis ships no model credentials and calls no provider until you give it one. On first run, open the UI, go to Settings, add a model provider with its API key, and select a model. Until you do, there is nothing for a chat to talk to. Keys are stored in the local database described below and are never sent anywhere except to the provider you chose.

## Where your data lives

The SQLite database defaults to `~/.amanuensis/db/db.sqlite` (`%USERPROFILE%\.amanuensis\db\db.sqlite` on Windows). It holds your chats, agents, connectors, and provider credentials. Back up or delete that directory to back up or reset Amanuensis.

Set `SQLITE_PATH` to put the database somewhere else:

```sh
SQLITE_PATH=/data/amanuensis.sqlite npx amanuensis
```

Sandbox working directories are created under the operating system's own application data directory rather than `~/.amanuensis`, because the server resolves them from a platform data path that has no environment override.

## Standalone only

`npx amanuensis` runs in standalone mode: SQLite, no Redis. That is local use only and is not production-safe. It is a single process with no peering, so it cannot be scaled across replicas, and it has no backup or migration story beyond copying the database file.

For a multi-replica deployment, run the server with `STANDALONE=false` against Postgres and Redis.

## What this package is

A thin wrapper. It carries the server, the compiled UI, and the database migrations in one tarball so `npx` needs nothing else. The server itself is developed in this repository's `packages/trueforge`, a fork of TrueForge, and is rebuilt into this package on every release.
