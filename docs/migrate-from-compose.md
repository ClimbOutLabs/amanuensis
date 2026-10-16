# Move from the old compose stacks to installer instances

This is a step-by-step guide for moving each person from an old docker compose stack (Postgres, Redis, sign-in with OIDC) to a new installer instance (SQLite, one account). It assumes a Linux server where the old stacks live under `~/aman-prod/<person>/`, with compose project names like `aman-prod-<person>` and an app container named `aman-prod-<person>-aman-1`.

Nothing here touches the old stacks except to read from them. They keep running the whole time, so going back is always possible.

Do one person at a time, from step 1 to step 6. Where a command says `<person>`, use the same short name the old project uses. Every value you need is read from the old app container, so there is nothing to look up by hand.

## What moves and what does not

Moves: chats with their original dates, folders, agents and their instructions, personas and their knowledge documents, memories, spaces with their current content, schedules (all switched off), connector entries, and your permission settings.

Does not move: model keys, connector sign-ins and saved credentials, and "Always allow" choices. Step 7 lists what to redo by hand.

Good to know:

- Each new instance has exactly one account, the owner's email. Everything that person owned is re-owned to it. The old sign-in subject is not used any more.
- Personas, spaces, folders and schedules show the import time as their date. Chats keep their own dates.
- Connectors were shared by the whole old instance, so a connector list carries every connector of that stack. With one stack per person this is the person's own list.

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
mkdir -p "$WORK/out"
```

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
git clone https://github.com/ClimbOutLabs/amanuensis.git
cd amanuensis
git fetch origin feat/data-import-migration
git checkout feat/data-import-migration
git pull origin feat/data-import-migration
```

If you already have a checkout, skip the clone. Once this work is merged, use `main` instead of the branch.

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

Define a short helper that runs the new image against that copy, with the copied folders mounted:

```bash
aman_copy() {
  docker run --rm --network "mig-$PERSON-net" \
    -e STANDALONE=false -e NODE_ENV=production -e TRUEFORGE_API_KEY=unused-export-only \
    -e POSTGRES_HOST="mig-$PERSON-pg" -e POSTGRES_PORT=5432 \
    -e POSTGRES_USER="$PGUSER" -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB="$PGDB" \
    -e MEMORY_BACKEND=markdown -e MEMORY_MARKDOWN_DIR=/data/memory -e PERSONA_KNOWLEDGE_DIR=/data/persona-knowledge \
    -v "mig-$PERSON-memory":/data/memory -v "mig-$PERSON-knowledge":/data/persona-knowledge \
    -v "$WORK/out":/out aman-migrate:new aman "$@"
}
chmod 777 "$WORK/out"
```

List the people who own chats in the copy, then export the owner. Use the id exactly as the list shows it (the OIDC subject). A line named `trueforge-default` with 0 sessions is always listed; ignore it.

```bash
aman_copy export-data --migrate --list-users
aman_copy export-data --migrate --user '<oidc-subject>' --out /out/$PERSON.zip
```

`--migrate` brings the old database forward to the new schema. It changes only the temporary copy. The export prints one line of JSON and exits 0. Exit codes are 0 for success, 1 for a failure (one plain line says why) and 2 for a bad command line.

The export writes the file as a private file of the container's user. Give it back to yourself:

```bash
docker run --rm -v "$WORK/out":/out alpine:3.21 chown "$(id -u):$(id -g)" "/out/$PERSON.zip"
chmod 700 "$WORK/out"
ls -l "$WORK/out"
```

Tidy up the temporary Postgres (keep the safety copies from step 1):

```bash
docker rm -f "mig-$PERSON-pg"
docker network rm "mig-$PERSON-net"
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

The installer asks for the owner's password and, if you want it, a model address or key. Say "this computer only" or give the address people will use. Give each instance the email the person signs in with: the new instance recognises them by it.

The first start of an instance downloads the memory search model once (about 120 MB). You can follow it with:

```bash
docker logs -f aman-$PERSON-app-1
```

Look for "Downloading the memory search model once" and wait until the logs go quiet. Opening the app and signing in once is a good way to be sure it is up. Persona knowledge is searched by meaning, so the import needs this model; if it is not ready the import refuses and writes nothing (step 5 shows the message), and you simply try again a few minutes later.

## 5. Import

```bash
installer/install.sh instance import $PERSON "$WORK/out/$PERSON.zip"
```

This stops the app of that instance, restores the file in a one-off container with no network, and starts the app again. It prints a summary such as "Imported 5 chats, 3 memories, 2 personas, 1 space, 1 agent, 2 schedules (off)." and exits 0.

If it says "The knowledge index is still downloading, retry in a few minutes", the search model is not finished. Nothing was written. Wait and run the same command again.

If it says the instance already has chats or other data, the instance is not fresh. Remove it and add it again, then import:

```bash
installer/install.sh instance remove $PERSON --purge-data
installer/install.sh instance add $PERSON --email <owner-email>
```

A failed import leaves the instance as it was and always starts the app again. The import only ever writes into a fresh instance and refuses any user other than the instance owner.

## 6. Check the result

1. Compare the counts in the import summary with what you wrote down: chats, personas, spaces, agents, schedules. The chat count must equal the session count from `--list-users`.
2. Sign in as the owner. Open the chat list and check that the oldest and newest chats are there, with their original dates and in the same order, and open one that used a tool and one that asked for approval.
3. Open Settings and check agents (their instructions), personas (and their knowledge), spaces (and their history), and memory. Ask the assistant something only a memory would know; recall should find it.
4. Check that schedules are listed and switched off.
5. Run `aman doctor` (see the install guide) and make sure nothing fails.

Only that person's data should be there. If the old stack held more than one person, only the chosen person's chats, agents, schedules, personas and spaces were exported.

## 7. What to redo by hand

- Model keys and the model server address: Settings, Models. Keys are never exported.
- Connector sign-ins: a connector that signs in with OAuth arrives with a "sign in" button; click it. A connector that used a header token or a fixed client id and secret arrives without those values: open it in Settings, Connectors, and enter them again.
- "Always allow" choices: each tool asks again the first time and you can pick Always allow once more.
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
