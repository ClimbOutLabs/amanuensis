# Aman install state: the layout

Every Aman install keeps its state in one home folder. The shell installer
(`install.sh` and `installer/lib/*.sh`) writes it today, the doctor shim
(`installer/doctor/aman`, installed as `bin/aman`) reads it, and the TypeScript
installer in `packages/aman-installer` reads and writes the same files. This
document is the contract between them: the layout never changes shape, so an
install made by one can always be read by the others, and any one of them can
be rolled back alone.

## Where the home is

- Mac and Linux: `~/.amanuensis` on the host.
- Windows: the Docker volume `aman_home`, mounted at `/root/.amanuensis`
  inside the setup container. The source checkout lives in the volume
  `aman_source`, mounted at `/src`.
- The doctor shim finds the home from `AMANUENSIS_HOME` when it is set, else
  from the `state/source` file next to its own install folder, else
  `~/.amanuensis`.

Paths below are relative to the home.

## The layout

| Path                                      | What it holds, and who writes it                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `state/instances/<name>.conf`             | The instance registry: one file per instance, written by `registry.sh`. Holds no secrets.                            |
| `state/source`                            | One line: the checkout folder the install came from. Written by `instance.sh`.                                       |
| `state/installed`                         | One line: the UTC time of the install or upgrade, then the app image it left running. Written by `plan.sh`.          |
| `state/backups`                           | One word, `daily` or `off`: whether daily backups are on. Written by `schedule.sh`.                                  |
| `state/lock/`                             | The run lock: a folder taken with `mkdir`, holding `owner`, `beat` and `pid`. See "The lock".                        |
| `state/logs/`                             | One log file per install step, written by `common.sh`.                                                               |
| `release/release.json`                    | The record of what is installed. Written by `release.sh` on install and upgrade.                                     |
| `release/previous.release.json`           | The release record from before the last upgrade, kept so an upgrade can roll back.                                   |
| `instances/<name>/compose.yaml`           | The instance's Compose file, rendered by `instance.sh`.                                                              |
| `instances/<name>/.env`                   | The instance's settings for the app. Holds secrets (the model key and any Twilio auth token). Mode 600.              |
| `instances/<name>/dex.env`                | The instance's settings for the sign-in service. Holds the password hash. Mode 600.                                  |
| `instances/<name>/local-model-bridge.mjs` | The local model bridge script both of its sides run, copied from the checkout while the instance carries a port.     |
| `machine/compose.yaml`, `machine/.env`    | The shared speech service's Compose file and settings, rendered by `instance.sh`.                                    |
| `tls/ca/`                                 | The local certificate authority: `root.crt` and `root.key`. The key is mode 600. Written by `tls.sh` with `pki.mjs`. |
| `tls/leaf/<name>/`                        | The https certificate for one instance, issued by the authority.                                                     |
| `tls/trust/<name>/`                       | The trust page files served to other devices for one instance.                                                       |
| `backups/<timestamp>/`                    | One folder per backup. See "Backups".                                                                                |
| `bin/aman`                                | The doctor shim, copied in by the installer on install and upgrade. Mode 755.                                        |
| `bin/aman-sandbox.mjs`                    | The sandbox setup copy the doctor runs.                                                                              |
| `runtime/`                                | What the installer downloads to run itself, including `runtime/node/` (the pinned Node).                             |

Texts through Twilio are set up by the owner in the `.env`, below the managed block:
`REACH_SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_FROM_NUMBER` and `TWILIO_WEBHOOK_PUBLIC_URL`, with `TWILIO_WEBHOOK_PORT`
if they want a port of their own. The installer reads these lines the way
Compose does (`export`, quotes, a trailing comment and case on the provider line
do not matter), through the one `.env` reader in `lib/shared.sh`. When
`REACH_SMS_PROVIDER=twilio` is in the `.env`, `instance_render` also publishes
one port in the instance's compose file, on `127.0.0.1` only, for
Tailscale Funnel or a web server on the same computer to carry on to Twilio,
and records it as `sms_port` in the instance's registry file. With no port set,
the instance keeps the port it has, else gets 9201 (outside the ranges app,
sign-in and https ports are picked from) or the next free port, and the
installer writes it as `TWILIO_WEBHOOK_PORT` in the managed block so the app
listens on it and it stays the same. In a `.env` with no managed block the pick
cannot be written, so it is published onto the port the app listens on there
(`TWILIO_WEBHOOK_PORT`, else 9201). A port another instance already publishes
stays with that instance. A port the owner set that another instance's app,
sign-in, https or Twilio port uses, or that Aman uses inside the instance, is
not published: the installer names the line to change. The registry also keeps
`sms_settings`, a short digest of the `.env` lines that set up texts, the
`REACH_SMS_*` and `TWILIO_*` lines (never the lines themselves). A plain re-run of the installer redraws and restarts the
instance when the port or that digest differs from the recorded one, so turning
texts on or off, or changing the port, the auth token or any other texts line,
needs no upgrade. New instances never pick a recorded `sms_port`. The listener
behind it serves only Twilio's routes, for texts and for phone calls (including
the call's `wss://` media stream on the same port). The app port is never opened
for it, and a `.env` without the provider line opens nothing. See
`docs/text-messages.md` and `docs/phone-calls.md`.

`LOCAL_MODEL_ENDPOINTS` is the owner's line below the managed block too: the
exact `host:port` model addresses the app may reach although they are on this
computer or on the instance's own networks. `aman local-model PORT` adds
`aman-local-model:PORT` to it, since the local model bridge sits on a network of
the instance, and `--remove` takes that one entry out. The command rewrites only
the last line Compose reads for the key, in place, or adds one at the end of the
file when there is none. It keeps every other entry and never adds one twice,
and drops the line when its list ends up empty. The instance starts again
afterwards, so the app reads the new list.

The `release.json` in a checkout's `installer/` folder is a different file:
it is the pins manifest the installer ships (image digests, among them the
helper image the Windows state commands run, and the Node version), not state. Only `release/release.json` in the home is state.

## The registry file

`state/instances/<name>.conf` is plain lines of `key=value`, one per line.
Readers take the first line that names a key. Writers keep the other lines
and their order when they change one key, and keep keys they do not know.
The keys an install writes at creation are:

`name`, `app_port`, `login_port`, `public_url`, `login_url`, `owner_email`,
`owner_name`, `cookie_suffix`, `client_id`, `healthy`, `origins`,
`extra_hosts`, `sandbox`, `tls`, `tls_port`, `token_factory`, `tf_model`,
`tf_cap`, `demo`, `created`.

Later steps add keys with the same rule (for example `healthy` is set to `1`
once an instance answers, `sms_port` holds the Twilio port the compose
file publishes, empty when none, `sms_settings` the digest of its texts
lines, empty when none, and `local_models` holds the comma-separated ports of
this computer that `aman local-model` named for the local model bridge). Instance names use lowercase letters, digits and
hyphens.

## The release record

`release/release.json` is a flat JSON object of string fields, nothing
nested:

```json
{
  "schema": "1",
  "source_ref": "<the checkout commit the images were built from>",
  "app_image": "aman-app:<source id>",
  "stt_image": "aman-stt:<source id>",
  "tts_image": "aman-tts:<source id>",
  "calendar_image": "aman-calendar-caldav:<source id>",
  "browser_image": "aman-browser:<source id>",
  "browser_gateway_image": "aman-browser-gateway:<source id>",
  "dex_image": "<image pinned by digest>",
  "mail_email_image": "<image pinned by digest>"
}
```

On upgrade the old record is copied to `release/previous.release.json`
before the new one is written. Readers treat the record as readable only
when at least the app, speech-to-text and sign-in images are named. A record
from before the read-aloud voice has no `tts_image`; the next upgrade adds it.

### Source ids and published images

Each `<source id>` names what an image is built from: the first 12
characters of the git tree of `ops/aman-stt`, `ops/aman-tts`,
`ops/calendar-sidecar` or `ops/browser-sidecar`, and for the app a hash of
`Dockerfile.dev`, `.dockerignore` and every path `Dockerfile.dev` copies.
Local changes add `-d<hash>`. `pnpm images:ids` prints them. An id from
before November 2026 named the app by its commit, so the first upgrade after
that reads as an update and puts the app image in place again.

The pins manifest `installer/release.json` can carry a
`published_<image>` entry for each Aman image:
`ghcr.io/climboutlabs/<name>:<source id>@sha256:<index digest>`, written
by the Images workflow (see `RELEASING.md`). When an entry's source id
equals the checkout's, the installer pulls that exact digest and tags it
with the local name instead of building. Otherwise, with
`--build-from-source`, or when the download fails, it builds as before.
The app is also built when `Dockerfile.dev` has a step the id cannot
follow: a JSON-form, continued or heredoc `COPY`, an `ADD` of a local file,
or a mount of the checkout.
The sandbox slot image is always built on the computer.

## Backups

Each backup is one folder under `backups/`, named with the UTC time it was
made (`%Y%m%dT%H%M%SZ`, for example `20261020T030405Z`), with `-<label>`
added when it carries a label, and `-1`, `-2` and so on when the name is
already taken. Inside: one folder per instance that was backed up, a copy of
`release/release.json`, a copy of the authority's `root.crt` under `tls/`
(never its key), and `SHA256SUMS` with the hash of every file. Unlabelled
backups are pruned to the newest seven. The database copy in each backup
holds no incognito chats: `aman backup` deletes them from its copy before the
copy is checked, so an incognito chat open at backup time is not kept.
`install.sh restore` reads these folders: it accepts a backup only when every
part its instance needs is there, `SHA256SUMS` matches, neither
`release.json`'s `schema` nor the instance's `manifest.json` version is newer
than this installer's, and `aman backup-check` in the installed app image finds
no database migration that image does not ship. The copy it saves first carries
the label `before-restore`. After writing the backup's `.env` it sets the keys
the registry owns again from the registry (`PUBLIC_BASE_URL`,
`ALLOWED_ORIGINS`, `AUTH_COOKIE_SUFFIX`, `OIDC_ISSUER_URL`,
`LOGIN_UPSTREAM_URL`, `OIDC_CLIENT_ID`) and drops `TRUSTED_PROXY_ADDRESSES`,
so `.env` and `dex.yaml` always name the same client. The owner goes the
other way: the registry's `owner_email` and `owner_name` are taken from the
backup, and `OIDC_ADMIN_ROLE_VALUE`, `OIDC_ALLOWED_EMAILS` and `OWNER_NAME`
are written from them. A restore with no answer on its input exits 1.
On Windows the backups are kept on the PC itself, in
`%LOCALAPPDATA%\Amanuensis\backups`, not in the `aman_home` volume. The
TypeScript installer's `aman backup` and `aman restore` run the shell's
`backup` and `restore` in the setup container with that folder mounted at
`/root/.amanuensis/backups`, so the shell reads and writes it as its own
`backups/`.

## The lock

Only one run works on a home at a time. The lock is the folder `state/lock`,
taken with `mkdir`, which is atomic everywhere. Three programs follow this
contract: the shell installer (`lock_acquire` in `lib/common.sh`), the
TypeScript installer's folder lock, and the script the TypeScript installer
runs against the `aman_home` volume. Each run, shell or TypeScript, uses the
same rules, so a lock taken by one is honoured by the others.

What the lock folder holds:

| File    | What it holds                                                                                |
| ------- | -------------------------------------------------------------------------------------------- |
| `owner` | A token only the holder knows. The holder removes the lock only while this is still its own. |
| `beat`  | The time of the holder's last sign of life, as whole seconds since 1970. Written by rename.  |
| `pid`   | The holder's process id, for people reading the folder. No run decides anything from it.     |

The rules:

- **The holder beats while it runs.** From the moment it holds the lock, the
  holder rewrites `beat` every 15 seconds, for as long as the run lasts. A
  run that builds images for an hour beats for an hour. The beat stops when
  the run ends or the holder process is gone, and it only ever touches a lock
  whose `owner` is still the holder's token.
- **A lock is dead only when its beat stopped.** A lock whose `beat` is more
  than 120 seconds old belongs to a holder that stopped without cleaning up.
  Age since the lock was made means nothing: a live holder can be an hour in.
  The pid means nothing either, because in the volume the holder ran in its
  own container, whose shell is process 1, so a pid there names that
  container's processes. The wait after a crash is therefore up to two
  minutes, and the busy message says so.
- **A lock with no beat yet gets a moment.** A holder is between `mkdir` and
  its first beat for a few milliseconds. A run that finds a lock with no
  readable `beat` looks again, up to three times a second apart, before it
  counts as dead.
- **Taking a dead lock is atomic.** A takeover goes through a second folder,
  `state/takeover`, made with `mkdir` like the lock itself, and only the run
  holding it may move a lock folder aside. So two runs that both find a dead
  lock cannot both move it. Under that folder the run judges the lock again,
  reads its `owner`, moves the folder aside with one `mv` to a name of its own
  (`lock.stale-<token>`), and checks that what it moved still has that
  `owner` and a stopped `beat`. If not, it moved a live lock another run had
  just made, so it puts the folder back. Otherwise it removes the moved
  folder, makes the lock with `mkdir`, and removes `state/takeover`. A
  `state/takeover` left by a crashed run holds a `since` time and is judged
  by the same dead limit. Every way out of a takeover that does not leave the
  run holding the lock counts as busy. After writing its `owner`, the run
  reads it back and, if it is not its own, waits a second once (the folder
  may be on its way back) before giving up as busy.
- **Only the owner removes the lock.** At the end of a run, the holder removes
  `state/lock` only if `owner` still holds its token. A holder whose lock was
  taken over leaves the new holder's lock alone.
- **Busy is exit code 3** in the volume script, and the busy message in every
  program names the wait: wait for the run to finish, or two minutes if an
  install was stopped a moment ago.

The numbers (15 and 120 seconds) are `LOCK_BEAT_SECONDS` and
`LOCK_DEAD_SECONDS` in `lib/common.sh`, and `LOCK_TIMING` in
`packages/aman-installer/src/state/lockTiming.ts`. Tests in
`installer/tests/lib/lock.test.sh` and `packages/aman-installer/tests/state`
run the real code with a short clock, including each program holding the lock
longer than the dead limit while the others stay out.

## Rules every writer follows

- State folders are mode 700; files that hold secrets (the registry, the
  release record, `.env`, `dex.env`, the authority's key) are mode 600.
- Writers write only what changed: the new text goes to a temp file next to
  the old one, is compared, and replaces it only when it differs.
- The registry holds no secrets. Secrets live in `instances/<name>/.env`,
  `instances/<name>/dex.env` and `tls/ca/root.key`, and never leave the
  home.
- Volumes an instance owns on Docker are named after it: `aman_<name>_data`
  and `aman_<name>_dex`, its Compose project is `aman-<name>`, and the
  shared volumes are `aman_home`, `aman_source`, `aman_stt_cache` and
  `aman_machine`.
