import { createHash } from 'node:crypto';
import type { Logger } from 'winston';

import type { TelegramConnection } from '../../db/telegramStore';
import type { TelegramClient, TelegramInlineButton } from './telegramClient';
import { sendTelegramText, type TelegramSendQueue } from './telegramSendQueue';

/**
 * The bot's command menu: the commands Telegram lists beside the text box, and what each one does.
 * A command with choices answers with one button per choice, the one in use ticked; a tap switches.
 * Everything here changes only the Telegram chat, the same setting the app shows for that chat.
 */

/** The commands the menu lists, in the order Telegram shows them. */
export const TELEGRAM_COMMANDS = [
  { command: 'new', description: 'Start a fresh chat' },
  { command: 'model', description: 'Pick the model that answers' },
  { command: 'persona', description: 'Pick who answers' },
  { command: 'connectors', description: 'Turn connectors on or off' },
  { command: 'status', description: 'See what this chat uses' },
] as const;

export type TelegramCommand = (typeof TELEGRAM_COMMANDS)[number]['command'] | 'help';

/** The most choices one message offers. Telegram allows more, but a longer list is hard to use on a phone. */
export const TELEGRAM_MAX_CHOICES = 30;

/** One thing a person can pick: its key rides the button, its label is what the button says. */
export interface TelegramChoice {
  key: string;
  label: string;
  current: boolean;
}

/** What the Telegram chat uses right now, in words. */
export interface TelegramChatSetup {
  model: string;
  persona: string;
  /** Set when the persona answers on its own model rather than the chat's. */
  persona_model: string | null;
  connectors: string[];
}

/** Reads and changes the Telegram chat's setup. The server wires it to the chat's stores. */
export interface TelegramChatControlsPort {
  setup(connection: TelegramConnection): Promise<TelegramChatSetup>;
  models(connection: TelegramConnection): Promise<TelegramChoice[]>;
  /** The label of the model now in use, or undefined when the key matches no model any more. */
  setModel(input: { connection: TelegramConnection; key: string }): Promise<string | undefined>;
  personas(connection: TelegramConnection): Promise<TelegramChoice[]>;
  setPersona(input: { connection: TelegramConnection; key: string }): Promise<string | undefined>;
  connectors(connection: TelegramConnection): Promise<TelegramChoice[]>;
  /** The connector's label and whether it is now on, or undefined when the key matches none any more. */
  toggleConnector(input: {
    connection: TelegramConnection;
    key: string;
  }): Promise<{ label: string; on: boolean } | undefined>;
  newChat(connection: TelegramConnection): Promise<void>;
}

/** A short, stable key for a name, small enough for a button's 64-byte data. */
export function telegramChoiceKey(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 16);
}

/** The menu command a message is, or undefined for an ordinary message. `/model@my_bot` counts as `/model`. */
export function telegramCommandOf(text: string): TelegramCommand | undefined {
  const match = /^\/([a-z]+)(?:@\w+)?$/i.exec(text.trim());
  const name = match?.[1]?.toLowerCase();
  if (name === 'help') {
    return 'help';
  }
  return TELEGRAM_COMMANDS.find(entry => entry.command === name)?.command;
}

const CONTROL_PREFIX = 'tc:';
const PICK_KINDS = { m: 'model', p: 'persona', c: 'connector' } as const;
type PickKind = (typeof PICK_KINDS)[keyof typeof PICK_KINDS];

function pickData(input: { kind: PickKind; key: string }): string {
  const code = Object.entries(PICK_KINDS).find(([, kind]) => kind === input.kind)?.[0] ?? 'm';
  return `${CONTROL_PREFIX}${code}:${input.key}`;
}

/** The pick a tapped button carries, or undefined when the button is not one of these menus'. */
export function parseTelegramPick(data: string | undefined): { kind: PickKind; key: string } | undefined {
  if (!data?.startsWith(CONTROL_PREFIX)) {
    return undefined;
  }
  const [code, key] = data.slice(CONTROL_PREFIX.length).split(':');
  const kind = code === 'm' || code === 'p' || code === 'c' ? PICK_KINDS[code] : undefined;
  if (kind === undefined || key === undefined || key === '') {
    return undefined;
  }
  return { kind, key };
}

function choiceButtons(input: { kind: PickKind; choices: readonly TelegramChoice[] }): TelegramInlineButton[][] {
  return input.choices.slice(0, TELEGRAM_MAX_CHOICES).map(choice => [
    {
      text: choice.current ? `✓ ${choice.label}` : choice.label,
      callback_data: pickData({ kind: input.kind, key: choice.key }),
    },
  ]);
}

function moreLine(choices: readonly TelegramChoice[]): string {
  return choices.length > TELEGRAM_MAX_CHOICES
    ? `\nThe first ${String(TELEGRAM_MAX_CHOICES)} are shown. Pick from the rest in Aman.`
    : '';
}

export function telegramSetupText(setup: TelegramChatSetup): string {
  const lines = [
    `Model: ${setup.model}`,
    `Persona: ${setup.persona}`,
    `Connectors on: ${setup.connectors.length === 0 ? 'None' : setup.connectors.join(', ')}`,
  ];
  if (setup.persona_model !== null) {
    lines.push(`${setup.persona} answers on its own model, ${setup.persona_model}.`);
  }
  return lines.join('\n');
}

const HELP_TEXT = [
  'Tap the menu button beside the text box, or send one of these:',
  ...TELEGRAM_COMMANDS.map(entry => `/${entry.command} - ${entry.description}`),
].join('\n');

export interface TelegramControlsDeps {
  controls: TelegramChatControlsPort;
  queue: TelegramSendQueue;
  logger: Logger;
}

/** Answers one menu command from the paired person. */
export async function handleTelegramCommand(
  deps: TelegramControlsDeps,
  input: { client: TelegramClient; connection: TelegramConnection; chat_id: string; command: TelegramCommand },
): Promise<void> {
  const { client, connection, chat_id } = input;
  const send = (text: string, buttons?: TelegramInlineButton[][]) =>
    sendTelegramText({ queue: deps.queue, client, chat_id, text, inline_buttons: buttons });
  switch (input.command) {
    case 'help':
      await send(HELP_TEXT);
      return;
    case 'status':
      await send(telegramSetupText(await deps.controls.setup(connection)));
      return;
    case 'new':
      await deps.controls.newChat(connection);
      await send('Started a fresh chat. The earlier one stays in Aman.');
      return;
    case 'model': {
      const choices = await deps.controls.models(connection);
      if (choices.length === 0) {
        await send('No models are set up yet. Add one in Aman, under Settings, Models.');
        return;
      }
      await send(
        `Pick the model for this chat. The one in use is ticked.${moreLine(choices)}`,
        choiceButtons({ kind: 'model', choices }),
      );
      return;
    }
    case 'persona': {
      const choices = await deps.controls.personas(connection);
      if (choices.length <= 1) {
        await send('You have no personas yet. Make one in Aman, under Settings, Personas.');
        return;
      }
      await send(
        `Pick who answers in this chat. The one answering now is ticked.${moreLine(choices)}`,
        choiceButtons({ kind: 'persona', choices }),
      );
      return;
    }
    case 'connectors': {
      const choices = await deps.controls.connectors(connection);
      if (choices.length === 0) {
        await send('No connectors are ready yet. Connect one in Aman, under Settings, Connectors.');
        return;
      }
      await send(
        `Tap a connector to turn it on or off for this chat. The ones on are ticked. To connect a new one, open Aman.${moreLine(choices)}`,
        choiceButtons({ kind: 'connector', choices }),
      );
      return;
    }
  }
}

/** Applies one tapped pick and says what changed. The returned text is the short note on the tapped button. */
export async function handleTelegramPick(
  deps: TelegramControlsDeps,
  input: {
    client: TelegramClient;
    connection: TelegramConnection;
    chat_id: string;
    pick: { kind: PickKind; key: string };
  },
): Promise<string> {
  const { client, connection, chat_id, pick } = input;
  const send = (text: string) => sendTelegramText({ queue: deps.queue, client, chat_id, text });
  const gone = 'That choice is no longer there. Send the command again to see the current list.';
  switch (pick.kind) {
    case 'model': {
      const label = await deps.controls.setModel({ connection, key: pick.key });
      if (label === undefined) {
        return gone;
      }
      await send(`This chat now uses ${label}.`);
      return 'Switched.';
    }
    case 'persona': {
      const label = await deps.controls.setPersona({ connection, key: pick.key });
      if (label === undefined) {
        return gone;
      }
      await send(`${label} answers from now on.`);
      return 'Switched.';
    }
    case 'connector': {
      const toggled = await deps.controls.toggleConnector({ connection, key: pick.key });
      if (toggled === undefined) {
        return gone;
      }
      await send(`${toggled.label} is ${toggled.on ? 'on' : 'off'} for this chat.`);
      return toggled.on ? 'Turned on.' : 'Turned off.';
    }
  }
}

/**
 * Sets the command menu once per connection per process, in the paired person's chat only. The menu
 * lives on Telegram's side, so a failure only means the menu is missing until the next try.
 */
export function createTelegramCommandMenu(): {
  ensure(input: { client: TelegramClient; connection: TelegramConnection; logger: Logger }): Promise<void>;
} {
  const done = new Set<string>();
  return {
    async ensure({ client, connection, logger }) {
      const chat_id = connection.paired_chat_id;
      if (chat_id === null) {
        return;
      }
      const key = `${connection.id}:${chat_id}`;
      if (done.has(key)) {
        return;
      }
      done.add(key);
      try {
        await client.setMyCommands({ chat_id, commands: TELEGRAM_COMMANDS });
      } catch (error) {
        done.delete(key);
        logger.warn('The Telegram command menu could not be set', {
          connection_id: connection.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
