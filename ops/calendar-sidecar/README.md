# Calendar connector (CalDAV)

This small service lets the Aman app read and change CalDAV calendars. It runs one
`@ni-c/caldav-mcp` tool server per connected account, behind a multiplexer at one plain HTTP
address, on the private Docker network only.

## What it does

- Serves the calendar tools at `http://calendar-caldav:9558/mcp` inside the Compose network, while at least one calendar login is saved. With no login saved, nothing listens on that port and no tools are offered.
- Offers eight tools: list calendars, list events, get an event, search events, create, update, delete, and respond to an event. Nothing else is offered.
- Asks for confirmation before a change is made.
- Runs a small account agent on port 9560, which the Settings Calendar card talks to. It answers only a caller that presents the instance's secret.
- Calendar and event ids name their account in front of a | sign, like `alice@example.com|/dav/alice/personal/`. A read that names no account spans every account, and each answer says which account a calendar or event belongs to. A change goes to the account its ids name, so an approval keeps acting on the account it was given on.

## Credentials

The calendar logins are kept in one file, `/account/.env.calendar`, in a volume this service owns. They are never copied into the image. The file holds one block of settings per account:

- `CALDAV_URL`: the address of the calendar server. It must be https.
- `CALDAV_USERNAME` and `CALDAV_PASSWORD`: the login.
- `CALDAV_USER_EMAIL`: your own email address, used to find your invitations.

A line `AMAN_CALENDAR_DEFAULT_ACCOUNT=<address>` names the default account when it is not the first one in the file. A file with one account reads exactly as it always has.

For a Google account, the Settings Calendar card and the installer fill in Google's CalDAV address from the email address.

Two things write the file, and both go through the account agent, which checks the address first:

- The Settings Calendar card, over the agent's HTTP port. The agent also checks the sign-in before it saves. The request must carry `Authorization: Bearer <CALENDAR_ACCOUNT_SECRET>` and a JSON body, or the agent refuses it (401 without the secret, 415 for another kind of body).
- The installer, with `install.sh instance calendar NAME`. The password goes to the agent on stdin only.

Each tool server always starts from this file and restarts when its account changes. Removing an account stops its tool server. Removing the last account deletes the file and closes the tool address.

## The account secret

`CALENDAR_ACCOUNT_SECRET` is a random value of at least 32 characters. The installer makes one per instance, keeps it in the instance's settings file and gives the same value to the app and to this service. Without a usable value the agent keeps its port closed and prints one line saying so; the saved account is still served, and the installer still saves accounts through the command line. The tool server never receives the secret.

## Which addresses are allowed

The calendar address may be on the internet or on your home or office network. These are never allowed, however the name is written: this computer itself (127.x, ::1), link-local addresses (169.254.x, fe80::), the special addresses cloud hosts use for their private settings, multicast and reserved ranges, and any other address on this service's own Compose network. The check runs on the address the connection actually uses. The sign-in check takes the same steps the calendar tool server takes to find the account. It asks the saved address first, with one trailing slash. If that address redirects, it asks the server's /.well-known/caldav address and follows at most one redirect from there, and only on the same server. A redirect to another server is never followed, so the login is never sent anywhere else.

## What a saved value may hold

The agent is the one place that decides which characters a value may hold. The address must be https with no name or password. The login name uses letters, numbers and `. _ + @ = -`. The email address is printable ASCII. The app password may hold any printable character, spaces inside included, but not at either end. A refused value is named by field (`url`, `username`, `password` or `email`), never repeated.

## Network access

The service has no published port, and it sits on a network of its own that only the app's network holder (`loopback`) shares. No other service, such as the mail connector, can reach it. Do not add a `ports:` entry for it, and do not put it on the default network.

## Check the tool list

Start the stack, then run this from inside the app container. It asks the connector for its tools:

```sh
docker compose exec server node -e "fetch('http://calendar-caldav:9558/mcp', {method:'POST', headers:{'content-type':'application/json','accept':'application/json, text/event-stream'}, body: JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/list', params:{}})}).then(r => r.text()).then(console.log)"
```

The answer lists the eight tools above. To run the same check without Docker, use `pnpm test:calendar-sidecar`.
