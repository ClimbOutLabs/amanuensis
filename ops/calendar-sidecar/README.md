# Calendar connector (CalDAV)

This small service lets the Aman app read and change a CalDAV calendar. It runs the
`@ni-c/caldav-mcp` tool server behind a plain HTTP address, on the private Docker network only.

## What it does

- Serves the calendar tools at `http://calendar-caldav:9558/mcp` inside the Compose network.
- Offers eight tools: list calendars, list events, get an event, search events, create, update,
  delete, and respond to an event. Nothing else is offered.
- Asks for confirmation before a change is made.

## Credentials

Put the calendar login in a file named `.env.calendar` next to `docker-compose.yml`.
That file is the only place the login comes from. It is git-ignored and is never copied
into the image. Its settings are:

- `CALDAV_URL`: the address of the calendar server.
- `CALDAV_USERNAME` and `CALDAV_PASSWORD`: the login.
- `CALDAV_USER_EMAIL`: your own email address, used to find your invitations.

If the file is missing, the service still starts, but calendar tools will not work.

## Network access

The service has no published port. Only other services in the same Compose project can reach it.
Do not add a `ports:` entry for it.

## Check the tool list

Start the stack, then run this from inside the app container. It asks the connector for its tools:

```sh
docker compose exec server node -e "fetch('http://calendar-caldav:9558/mcp', {method:'POST', headers:{'content-type':'application/json','accept':'application/json, text/event-stream'}, body: JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/list', params:{}})}).then(r => r.text()).then(console.log)"
```

The answer lists the eight tools above. To run the same check without Docker, use `pnpm test:calendar-sidecar`.
