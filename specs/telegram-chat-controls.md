# Spec: Telegram Chat Controls

**Status:** approved

## Problem

The Telegram chat has no composer. A person talking to Aman from Telegram cannot switch the model, pick a persona, turn a connector on or off, or start a fresh chat without opening the app. Asking for a persona by name in a Telegram message also did nothing, because Telegram turns ran without a persona.

## Solution

The bot gets a command menu, the list Telegram shows beside the text box:

- `/new` starts a fresh chat. The earlier one stays in the app.
- `/model` lists the models as buttons, the one in use ticked. A tap switches.
- `/persona` lists the assistant and the personas as buttons. A tap switches.
- `/connectors` lists the connectors already set up as buttons, the ones on ticked. A tap turns one on or off.
- `/status` says which model, persona and connectors the chat uses.
- `/help` lists the commands.

Every change applies only to the Telegram chat and is the same setting the app shows for that chat. Telegram turns now answer as the chat's persona, and asking for a persona by name works as it does in the app.

## Design Decisions

**Commands and buttons, no Mini App.** A Mini App needs a public https address, which most installs do not have. Commands and inline buttons work on every install.

**Connecting a new connector stays in the app.** Signing in to a service needs a browser and secrets. `/connectors` only turns on or off connectors the person has already set up.

**Set at start, not on first message.** Aman sets the menu for each paired chat soon after it starts or after pairing, so the person sees it without writing first. The common plural spellings `/models`, `/personas` and `/connector` answer as the commands they mean.

**Only the paired person.** Commands and button taps from anyone else are refused, as every other bot action is. The menu is set for the paired chat only.

**Short button data.** A button carries a short hash of the model, persona or connector name, because Telegram limits button data to 64 bytes. A tap on a choice that no longer exists says so and changes nothing.

**Forwarded and unknown commands are ordinary messages.** A forwarded `/model` is something to read, never an instruction, and an unknown command goes to the assistant.

## Scope

- The command menu and its handling in the Telegram channel
- Reading and changing the Telegram chat's model, persona and connectors
- Persona context and persona memory for Telegram turns
- The Telegram help page and the privacy page

## Privacy

The names of the person's models, personas and connectors pass through Telegram's servers when they use the menu. The privacy page lists this. Nothing else new leaves the device.

## Testing

Unit tests with a fake Telegram client cover each command, each kind of tap, a stranger's tap, and forwarded and unknown commands. A server test switches the model with a tap and starts a fresh chat with `/new`. All tests use synthetic data.

## Out of Scope

- Connecting new connectors from Telegram
- Mini Apps
- Group chats
