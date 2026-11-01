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
- The doctor shim finds the home from `AMANUENSIS_HOME` when it is set, else
  from the `state/source` file next to its own install folder, else
  `~/.amanuensis`.

Paths below are relative to the home.

## The layout

| Path                                   | What it holds, and who writes it                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `state/instances/<name>.conf`          | The instance registry: one file per instance, written by `registry.sh`. Holds no secrets.                            |
| `state/source`                         | One line: the checkout folder the install came from. Written by `instance.sh`.                                       |
| `state/installed`                      | One line: the UTC time of the install or upgrade, then the app image it left running. Written by `plan.sh`.          |
| `state/backups`                        | One word, `daily` or `off`: whether daily backups are on. Written by `schedule.sh`.                                  |
| `state/lock/`                          | The run lock: a folder taken with `mkdir`, holding `owner`, `beat` and `pid`. See "The lock".                        |
| `state/logs/`                          | One log file per install step, written by `common.sh`.                                                               |
| `release/release.json`                 | The record of what is installed. Written by `release.sh` on install and upgrade.                                     |
| `release/previous.release.json`        | The release record from before the last upgrade, kept so an upgrade can roll back.                                   |
| `instances/<name>/compose.yaml`        | The instance's Compose file, rendered by `instance.sh`.                                                              |
| `instances/<name>/.env`                | The instance's settings for the app. Holds secrets (the model key among them). Mode 600.                             |
| `instances/<name>/dex.env`             | The instance's settings for the sign-in service. Holds the password hash. Mode 600.                                  |
| `machine/compose.yaml`, `machine/.env` | The shared speech service's Compose file and settings, rendered by `instance.sh`.                                    |
| `tls/ca/`                              | The local certificate authority: `root.crt` and `root.key`. The key is mode 600. Written by `tls.sh` with `pki.mjs`. |
| `tls/leaf/<name>/`                     | The https certificate for one instance, issued by the authority.                                                     |
| `tls/trust/<name>/`                    | The trust page files served to other devices for one instance.                                                       |
| `backups/<timestamp>/`                 | One folder per backup. See "Backups".                                                                                |
| `bin/aman`                             | The doctor shim, copied in by the installer on install and upgrade. Mode 755.                                        |
| `bin/aman-sandbox.mjs`                 | The sandbox setup copy the doctor runs.                                                                              |
| `lib/`                                 | The helper files the aman command loads: shell libraries it shares with the installer, and `pki.mjs`.                |
| `runtime/`                             | What the installer downloads to run itself, including `runtime/node/` (the pinned Node).                             |

The `release.json` in a checkout's `installer/` folder is a different file:
it is the pins manifest the installer ships (image digests and the Node
version), not state. Only `release/release.json` in the home is state.

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
once an instance answers). Instance names use lowercase letters, digits and
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
  "calendar_image": "aman-calendar-caldav:<source id>",
  "dex_image": "<image pinned by digest>",
  "mail_email_image": "<image pinned by digest>"
}
```

On upgrade the old record is copied to `release/previous.release.json`
before the new one is written. Readers treat the record as readable only
when at least the app, speech and sign-in images are named.

## Backups

Each backup is one folder under `backups/`, named with the UTC time it was
made (`%Y%m%dT%H%M%SZ`, for example `20261020T030405Z`), with `-<label>`
added when it carries a label, and `-1`, `-2` and so on when the name is
already taken. Inside: one folder per instance that was backed up, a copy of
`release/release.json`, a copy of the authority's `root.crt` under `tls/`
(never its key), and `SHA256SUMS` with the hash of every file. Unlabelled
backups are pruned to the newest seven.

## The lock

Only one run works on a home at a time. The lock is the folder `state/lock`,
taken with `mkdir`, which is atomic everywhere. Two programs follow this
contract: the shell installer (`lock_acquire` in `lib/common.sh`) and the
TypeScript installer's folder lock. Each run, shell or TypeScript, uses the
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
  The pid means nothing either, because a holder can run in its own
  container, whose shell is process 1, so a pid there names that
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
- The busy message in every
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
  shared volumes are `aman_stt_cache` and
  `aman_machine`.
