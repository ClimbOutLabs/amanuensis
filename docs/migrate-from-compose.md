# Move from the old compose stacks to installer instances

This is a step-by-step guide for moving each person from an old docker compose stack (Postgres, Redis, sign-in through a separate login service) to a new installer instance (SQLite). Each person gets a new instance. It assumes a Linux server where the old stacks live under `~/aman-prod/<person>/`, with compose project names like `aman-prod-<person>` and an app container named `aman-prod-<person>-aman-1`.

Nothing here touches the old stacks except to read from them. They keep running the whole time, so going back is always possible.

Do one person at a time. The short way is two commands (see "The one command" below). Steps 1 to 7 are the same move by hand, for a stack the one command cannot read. Step 8 is only for going back. Where a command says `<person>`, use the same short name the old project uses. Every value you need is read from the old app container, so there is nothing to look up by hand.

## What moves and what does not

Moves: chats with their original dates, the files uploaded to them, folders, agents and their instructions, personas and their knowledge documents, memories, spaces with their current content, schedules (all switched off), connector entries (unused: no agent is attached to them), and your permission history. Imported chats never carry live approvals or approval grants: a chat that was waiting for an answer comes over with that request expired, and "Approve for this chat" choices start over.

The recall and tool-output checks of Settings, Memory come along. Permission settings (offline mode, web search without asking) and Always allow choices start fresh, so each tool asks again; re-asking is the safe default.

Does not move: model keys, connector sign-ins and saved credentials, and your own skills and registered repositories. A connector that points at a value on the server, such as an environment variable or a file, is refused. Step 7 lists what to redo by hand.

Good to know:

- Each person gets a new instance. Everything that person owned now belongs to the owner of the new instance, who signs in with their email. The old sign-in id is not used any more.
- Only import a file you exported yourself.
- Personas, spaces, folders and schedules show the import time as their date. Chats keep their own dates.
- Connectors were shared by the whole old instance, so a connector list carries every connector of that stack. With one stack per person this is the person's own list.

## The one command

Install the new instance first (step 4), then run, on the computer that runs the old stack:

```bash
aman migrate --from-compose ~/aman-prod/$PERSON
aman import ~/.amanuensis/exports/aman-export-<timestamp>.zip --display-name "<owner name>"
```

`aman migrate` takes the folder you run `docker compose` in for the old stack. It finds the old app by its memory folder and the Postgres of that same project, whatever the services are called. It dumps the old Postgres into a temporary Postgres, copies the memory and knowledge volumes into temporary volumes, runs `export-data --migrate` from those copies as the app user (uid 10001) into a volume, copies the archive to `~/.amanuensis/exports/` (mode 600), and removes every temporary piece. The old stack is never changed: its database is only read with `pg_dump`, and its volumes are mounted read-only. The export also reads the old settings file, `packages/trueforge/.env` in a checkout or `.env` next to `compose.yml` in a folder that has only the compose file, so a key that lived only there (the model API key, the OIDC client secret) is blanked in chat text and memory too. It prints the `aman import` line to run next, with the old display name.

If more than one person has chats in the stack, it lists their ids and stops: run it again with `--user <id>`. Shared memories and instance settings come along only when one person has chats there.

`aman import` is described in step 5. Then check the result (step 6) and redo what does not move (step 7).

## 0. What you need

- Docker with Compose v2 on the server, and enough free disk for a copy of each database and of the memory and knowledge folders.
- A git checkout of this repository. The installer builds the new images from it.
- The owner's email address for each new instance.
- Internet access for the first start of each new instance (it downloads the memory search model once).

Set these once per person, in the shell you use for the steps below:

```bash
export PERSON=<person>
export OLD=aman-prod-$PERSON
export APP=$OLD-aman-1
export WORK=$HOME/aman-migration/$PERSON
mkdir -p -m 700 "$WORK" "$WORK/out"
```

The folder is private to you (mode 0700). The export holds every chat and memory of that person, so keep it that way and do not loosen it.

## 1. Make a safety copy (the old stack keeps running)

Find the database settings and the two data folders from the running app container:

```bash
docker compose -p "$OLD" ps
PG=$(docker compose -p "$OLD" ps -q postgres)
PGUSER=$(docker exec "$APP" printenv POSTGRES_USER)
PGDB=$(docker exec "$APP" printenv POSTGRES_DB)
PGPASS=$(docker exec "$APP" printenv POSTGRES_PASSWORD)
MEM_VOL=$(docker inspect "$APP" --format '{{range .Mounts}}{{if eq .Destination "/data/memory"}}{{.Name}}{{end}}{{end}}')
KNOW_VOL=$(docker inspect "$APP" --format '{{range .Mounts}}{{if eq .Destination "/data/persona-knowledge"}}{{.Name}}{{end}}{{end}}')
echo "postgres container: $PG"; echo "memory volume: $MEM_VOL"; echo "knowledge volume: $KNOW_VOL"
```

All three of the last values must be filled in. If the Postgres service is not called `postgres`, use the name that `docker compose -p "$OLD" ps` shows. If a folder is a bind mount rather than a named volume, the volume name is empty: copy that folder with `cp -a` instead and use its path in step 3.

Dump the database. This is a consistent snapshot and does not stop anything:

```bash
docker exec "$PG" pg_dump -U "$PGUSER" -d "$PGDB" -Fc > "$WORK/prod.dump"
ls -l "$WORK/prod.dump"
```

Copy the memory and knowledge folders into new volumes. The new volumes are yours to read and change; the originals are only read:

```bash
for kind in memory knowledge; do
  src=$MEM_VOL; [ "$kind" = knowledge ] && src=$KNOW_VOL
  docker volume create "mig-$PERSON-$kind"
  docker run --rm -v "$src":/from:ro -v "mig-$PERSON-$kind":/to alpine:3.21 sh -c 'cp -a /from/. /to/'
done
```

If someone is chatting while the copy runs, a knowledge file can be caught mid-write. For the safest copy run this step when nobody is using that stack, or run it twice and keep the second.

## 2. Get the new code

```bash
cd ~
git clone <repository-url> amanuensis
cd amanuensis
git checkout main
git pull origin main
```

If you already have a checkout, skip the clone.

Build the new app image. The installer in step 4 builds the same image and reuses these layers, so this costs nothing twice:

```bash
docker build -f Dockerfile.dev --build-arg BUILD_REF="$(git rev-parse HEAD)" -t aman-migrate:new .
```

## 3. Export from a restored copy

Never point the export at the live database. Start a temporary Postgres and restore the dump into it:

```bash
docker network create "mig-$PERSON-net"
docker run -d --name "mig-$PERSON-pg" --network "mig-$PERSON-net" \
  -e POSTGRES_USER="$PGUSER" -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB="$PGDB" postgres:17
until docker exec "mig-$PERSON-pg" pg_isready -U "$PGUSER" -q; do sleep 1; done; sleep 2
docker exec -i "mig-$PERSON-pg" pg_restore -U "$PGUSER" -d "$PGDB" --no-owner < "$WORK/prod.dump"
```

The export runs as the app user (uid 10001), which owns the copied folders, and writes into a volume that user owns. The old settings file goes into your private work folder, readable by that user, so keys that lived only there are blanked too:

```bash
docker volume create "mig-$PERSON-out"
docker run --rm -v "mig-$PERSON-out":/out alpine:3.21 chown 10001:10001 /out
OLD_ENV=~/aman-prod/$PERSON/packages/trueforge/.env
[ -f "$OLD_ENV" ] || OLD_ENV=~/aman-prod/$PERSON/.env
install -m 644 "$OLD_ENV" "$WORK/old.env"
```

`$WORK` is mode 0700, so nobody else on this computer can reach the copy. Define a short helper that runs the new image against the copies:

```bash
aman_copy() {
  docker run --rm --network "mig-$PERSON-net" --user 10001:10001 -e HOME=/tmp \
    -e STANDALONE=false -e NODE_ENV=production -e TRUEFORGE_API_KEY=unused-export-only \
    -e POSTGRES_HOST="mig-$PERSON-pg" -e POSTGRES_PORT=5432 \
    -e POSTGRES_USER="$PGUSER" -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB="$PGDB" \
    -e MEMORY_BACKEND=markdown -e MEMORY_MARKDOWN_DIR=/data/memory -e PERSONA_KNOWLEDGE_DIR=/data/persona-knowledge \
    -v "mig-$PERSON-memory":/data/memory -v "mig-$PERSON-knowledge":/data/persona-knowledge \
    -v "$WORK/old.env":/migrate/old.env:ro -v "mig-$PERSON-out":/out aman-migrate:new aman "$@"
}
```

List the people who own chats in the copy, then export the owner. Use the id exactly as the list shows it (the old sign-in id). A line named `trueforge-default` with 0 sessions is always listed; ignore it.

```bash
aman_copy export-data --migrate --list-users
aman_copy export-data --migrate --include-uploads --secrets-env /migrate/old.env --user '<user-id>' --out /out/$PERSON.zip
```

`--migrate` brings the old database forward to the new schema. It changes only the temporary copy. `--include-uploads` brings the files uploaded to chats; they are kept in the database, so nothing more needs to be mounted. The export prints one line of JSON and exits 0.

Shared memories (what the assistant remembered outside any persona) are left out by default, because on a stack that more than one person used they mix everyone's memories. If `--list-users` shows only this person, export again with `--include-instance-data` added to bring them too. The export also leaves out a persona's memory when another person on the stack has a persona with the same name, and says so. Exit codes are 0 for success, 1 for a failure (one plain line says why) and 2 for a bad command line.

Copy the file out of the volume into your private folder, then check it:

```bash
docker run --rm -v "mig-$PERSON-out":/out:ro alpine:3.21 cat "/out/$PERSON.zip" > "$WORK/out/$PERSON.zip"
chmod 600 "$WORK/out/$PERSON.zip"
ls -l "$WORK/out"
```

Tidy up the temporary Postgres, the output volume and the settings copy (keep the safety copies from step 1):

```bash
docker rm -f "mig-$PERSON-pg"
docker network rm "mig-$PERSON-net"
docker volume rm "mig-$PERSON-out"
rm -f "$WORK/old.env"
```

Write down the `--list-users` session count for this person. You will compare it in step 6.

## 4. Install one new instance per person

For the first person, from the repository root:

```bash
installer/install.sh --name $PERSON --email <owner-email>
```

For every further person:

```bash
installer/install.sh instance add <person> --email <owner-email>
```

The installer asks for the instance name, whether to back up every day, `Go ahead?` after its plan, and the owner's password twice. It does not ask for a model address or key: those are set in the app afterwards (step 7). Give each instance the email the person signs in with: the new instance recognises them by it.

The first start of an instance downloads the memory search model once (about 120 MB). The import waits for it by itself (step 5).

## 5. Import

```bash
aman import "$WORK/out/$PERSON.zip" --instance $PERSON --display-name "<owner name>"
```

`aman import FILE` runs `installer/install.sh instance import <name> FILE`; `--instance` can be left out when the computer has one instance. `--display-name` is how imported chats name the owner; without it the import asks, and Enter keeps the part of the email before the `@`.

Before anything is written, the import starts the instance once if it never started, waits for the search model with one line ("Waiting for instance ... to finish downloading its search model"), and takes a backup named `<timestamp>-before-import` under `~/.amanuensis/backups/`, which is never pruned. Then it stops the app of that instance, restores the file in a one-off container with no network, and starts the app again. It prints a summary such as "Imported 5 chats, 3 memories, 2 personas, 1 space, 1 agent, 2 schedules (off)." and exits 0.

If it says the instance already has chats or other data, the instance is not fresh. Remove it and add it again, then import:

```bash
installer/install.sh instance remove $PERSON --purge-data
installer/install.sh instance add $PERSON --email <owner-email>
```

A failed import always starts the app again and prints one line, `Import failed:` followed by the reason and what to do next. The full output is kept in the log file named under it. If the instance was used after an interrupted import, nothing is removed. The import only ever writes into a fresh instance and refuses any user other than the instance owner.

## 6. Check the result

1. Compare the counts in the import summary with what you wrote down: chats, personas, spaces, agents, schedules. The chat count must equal the session count from `--list-users`. If the summary says uploaded files were left behind, the export was made without `--include-uploads`; export again with it.
2. Sign in as the owner. Open the chat list and check that the oldest and newest chats are there, with their original dates and in the same order, and open one that used a tool and one that asked for approval.
3. Open Settings and check agents (their instructions), personas (and their knowledge), spaces (and their history), and memory. Ask the assistant something only a memory would know; recall should find it.
4. Check that schedules are listed and switched off.
5. Run `aman doctor` (see the install guide) and make sure nothing fails.

Only that person's data should be there. If the old stack held more than one person, only the chosen person's chats, agents, schedules, personas and spaces were exported.

## 7. What to redo by hand

- Model keys and the model server address: Settings, Models. Keys are never exported.
- Connector sign-ins: a connector that signs in through its own website arrives with a "sign in" button; click it. A connector that used a header token or a fixed client id and secret arrives without those values: open it in Settings, Connectors, and enter them again.
- Imported connectors: each one arrives unused, with no agent attached. Attach the ones you want to your agents again. If you ran a web search or memory connector, set that role again too.
- Permission settings: in Settings, open Permissions and set offline mode and web search again if you want them. The recall and tool-output checks came along.
- "Always allow" choices: each tool asks again the first time, which is the safe default, and you can pick Always allow once more.
- Schedules: they arrive switched off. Review each one and switch on the ones you want.

## 8. Roll back

The old stack was never changed, so it is still the source of truth until you decide otherwise. To stop using a new instance and go back:

```bash
installer/install.sh instance remove <person> --purge-data
```

Point people at the old address again. To clean up the migration leftovers when you no longer need them:

```bash
docker volume rm "mig-$PERSON-memory" "mig-$PERSON-knowledge"
rm -rf "$WORK"
```

Keep the dump and the copied volumes until the new instance has been in daily use for a while, and keep the old stack until you are sure.
