# Calendar connector (CalDAV)

This small service lets the Aman app read and change a CalDAV calendar. It runs the
`@ni-c/caldav-mcp` tool server behind a plain HTTP address, on the private Docker network only.

## What it does

- Serves the calendar tools at `http://calendar-caldav:9558/mcp` inside the Compose network, while a calendar login is saved. With no login saved, nothing listens on that port and no tools are offered.
- Offers eight tools: list calendars, list events, get an event, search events, create, update, delete, and respond to an event. Nothing else is offered.
- Asks for confirmation before a change is made.
- Runs a small account agent on port 9560, which the Settings Calendar card talks to. It answers only a caller that presents the instance's secret.

## Credentials

The calendar login is kept in one file, `/account/.env.calendar`, in a volume this service owns. The file is encrypted (see [The file's key](#the-files-key)). It is never copied into the image and never passed through the service's environment. Inside, its settings are:

- `CALDAV_URL`: the address of the calendar server. It must be https.
- `CALDAV_USERNAME` and `CALDAV_PASSWORD`: the login.
- `CALDAV_USER_EMAIL`: your own email address, used to find your invitations.

For a Google account, the Settings Calendar card and the installer fill in Google's CalDAV address from the email address.

Two things write the file, and both go through the account agent, which checks the address first:

- The Settings Calendar card, over the agent's HTTP port. The agent also checks the sign-in before it saves. The request must carry `Authorization: Bearer <CALENDAR_ACCOUNT_SECRET>` and a JSON body, or the agent refuses it (401 without the secret, 415 for another kind of body).
- The installer, with `install.sh instance calendar NAME`. The file's key and the password go to the agent on stdin only, the key on the first line.

The tool server always starts from this file and restarts when it changes. Removing the account deletes the file and stops the tool server.

## The file's key

The account file is encrypted with AES-256-GCM. Its key is worked out by the app from this computer's key, and is only for this file. The agent holds it in memory and never writes it down, so the volume alone opens nothing.

- The app asks the agent which key it holds (`GET /key`, which answers with a short name for the key, never the key) and hands the key over when it holds none (`POST /key`). It does this after each start of this service.
- Until the key arrives, an encrypted file reads as locked: the agent answers 423, and the tool server is not started. Nothing is saved without the key.
- A file from before encryption is still read, and is encrypted as soon as the key arrives.
- After the instance moves to another computer, the app also sends the key from the earlier computer. The agent opens the file with it and writes it again under the new key.
- A key that does not open the file is refused (409), and nothing changes.

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
