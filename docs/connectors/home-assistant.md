# Home Assistant

Aman can see and control the Home Assistant devices you choose to share, through Home Assistant's own MCP server. Reads run on their own. Anything that changes your home asks you first, unless you allow it for good. Locks, alarms and garage doors are never controlled.

## Connect Home Assistant

You need a Home Assistant that you can open in a browser, and about two minutes.

### Step 1: Make a token in Home Assistant

1. Open your Home Assistant and click your profile picture.
2. Click **Security**.
3. Under **Long-lived access tokens**, click **Create token**. Name it Aman.
4. Copy the token. Home Assistant shows it once.

### Step 2: Add the MCP server in Home Assistant

1. In Home Assistant, click **Settings**, then **Devices and services**.
2. Click **Add integration** and choose **Model Context Protocol Server**.
3. Click **Submit**.

### Step 3: Connect in Aman and choose what Aman can see

1. In Aman, click **More**, click **Settings**, then click **Connectors**.
2. Find **home-assistant** and click **Connect**.
3. Type your Home Assistant address, like `https://homeassistant.local:8123`, and paste the token.
4. Click **Connect**. Aman checks the connection and says how many tools and exposed entities it found, or the one thing to fix.
5. In Home Assistant, click **Settings**, then **Voice assistants**, then **Expose**, and expose each entity Aman may see or control. Only exposed entities are visible to Aman.

The address must use https, unless it is on your home network: an address on your own network may use http, because Home Assistant on a home network usually does. A Nabu Casa address or the https address Tailscale gives your Home Assistant both work.

The token is stored with the connector and is never shown again. If you lose it, make a new one in Home Assistant and replace it in Aman.

## What Aman can and cannot do

Aman works only with the entities you exposed. It cannot see or touch anything else in your home, and it cannot change Home Assistant itself: no automations, no settings, no new entities.

| What Aman wants to do                                                                                             | What happens                                               |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Read the state of your home (live context, one device's state, the list of exposed entities)                      | Runs without asking                                        |
| Turn something on or off, set the temperature, brightness or position, run a script, start a scene, control media | Asks first, with a card naming the device                  |
| The same change, for a device or a kind of device you allowed for good                                            | Runs without asking                                        |
| Unlock or lock a door, arm or disarm an alarm, open a garage door or a cover that leads outside                   | Refused. Aman never does these, and no setting allows them |

A refused call says: "Aman does not control locks, alarms or garage doors. Do that in Home Assistant."

When a card asks about a change, **Always allow everywhere** remembers your answer for that kind of device (all lights, all switches, all heating, all media players) or for the one device, the way mail remembers an address. You can see what you allowed, and take it back, under **Settings**, **Connectors**, on the Home Assistant connector's page.

If something Aman read, like an email, asks for a change to your home, the change is refused. Only you can ask for a change.

## Example

You: Is the garage door closed?

Aman: Yes. The garage door is closed, the front door is locked, and the heating is set to 22 degrees.

You: Turn the heating down to 19 for the night.

Aman shows a card: "Set Hallway thermostat to 19 degrees", with **Allow**, **Always allow everywhere**, and **Not now**. You click **Allow**.

Aman: Done. The hallway thermostat is set to 19 degrees.

You: Unlock the front door for the cleaner.

Aman: Aman does not control locks, alarms or garage doors. Do that in Home Assistant.

## If the check says it could not connect

- **Nothing answered at that address.** Check the address and that Home Assistant is running.
- **Home Assistant refused the token.** Make a new long-lived access token and paste it in again.
- **The integration is not installed.** Add the Model Context Protocol Server integration in Home Assistant, under **Settings**, **Devices and services**.
- **The certificate cannot be checked.** The address probably uses a self-signed certificate. Use the http address on your home network, or the https address Tailscale gives your Home Assistant.

## For r/selfhosted

Aman now connects to Home Assistant through Home Assistant's own Model Context Protocol Server integration: you paste your HA address and a long-lived access token, and Aman sees only the entities you expose to voice assistants. Reads are free, so it can answer "is the garage door closed?" or fold "the heating is set to 22 while you're out" into your morning brief. Changes ask first, with a card naming the device, and you can allow a whole kind of device (all lights, all heating) for good and take it back in Settings. Locks, alarms and garage doors are off limits by design: Aman refuses them outright, with no setting to allow them, because the thing that can unlock your house should not be the thing that reads your email.
