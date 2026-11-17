import type { InstallStage } from '../commands/install.ts';

// The messages between the setup program and its window. The program
// decides everything; the window only draws what it is told and sends
// back what the person did. Each message is checked field by field,
// and anything that is not exactly one of these is refused.

export type ScreenName = 'welcome' | 'check' | 'about' | 'options' | 'review' | 'install' | 'done' | 'stopped';

export type RowMark = 'todo' | 'doing' | 'done' | 'failed';

export interface ScreenRow {
  id: string;
  label: string;
  mark: RowMark;
}

// The words the window shows that do not change from screen to
// screen, sent once when it opens.
export interface WindowWords {
  windowTitle: string;
  brand: string;
  steps: readonly string[];
  emailLabel: string;
  passwordLabel: string;
  ruleLabels: readonly string[];
  againLabel: string;
  keepLine: string;
  phoneYes: string;
  phoneNo: string;
  detailsLabel: string;
  markLabels: readonly string[];
  closeTitle: string;
  closeQuestion: string;
}

export type ToWindow =
  | { t: 'init'; words: WindowWords }
  | {
      t: 'screen';
      name: ScreenName;
      step: number;
      title: string;
      lines: readonly string[];
      rows: readonly ScreenRow[];
      panel: 'none' | 'about' | 'options';
      details: boolean;
      next: string | null;
      back: string | null;
      confirmClose: boolean;
    }
  | { t: 'row'; id: string; mark: RowMark }
  | { t: 'line'; text: string }
  | { t: 'problem'; text: string }
  | { t: 'buttons'; next: boolean; back: boolean }
  | { t: 'end' };

export type FromWindow =
  | { t: 'hello'; windowsDir: string; systemDir: string; modulePath: string; languageMode: string }
  | { t: 'next' }
  | { t: 'back' }
  | { t: 'about'; email: string }
  | { t: 'options'; phone: boolean }
  | { t: 'closing' };

export class ProtocolError extends Error {}

const PATH_CAP = 520;
export const EMAIL_CAP = 254;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const found = Object.keys(value);
  if (found.length !== keys.length || !keys.every(key => found.includes(key))) {
    throw new ProtocolError('a message with fields it should not have arrived');
  }
}

function text(value: unknown, cap: number): string {
  if (typeof value !== 'string' || value.length > cap) {
    throw new ProtocolError('a message field that is not short text arrived');
  }
  return value;
}

// One message from the window, read strictly: valid UTF-8, one JSON
// object, a known kind, exactly its own fields, each of its own type
// and no longer than it may be.
export function parseFromWindow(payload: Uint8Array): FromWindow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch (error) {
    throw new ProtocolError('a message that cannot be read arrived', { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new ProtocolError('a message that is not an object arrived');
  }
  switch (parsed['t']) {
    case 'hello':
      onlyKeys(parsed, ['t', 'windowsDir', 'systemDir', 'modulePath', 'languageMode']);
      return {
        t: 'hello',
        windowsDir: text(parsed['windowsDir'], PATH_CAP),
        systemDir: text(parsed['systemDir'], PATH_CAP),
        modulePath: text(parsed['modulePath'], PATH_CAP),
        languageMode: text(parsed['languageMode'], 64),
      };
    case 'next':
      onlyKeys(parsed, ['t']);
      return { t: 'next' };
    case 'back':
      onlyKeys(parsed, ['t']);
      return { t: 'back' };
    case 'about':
      onlyKeys(parsed, ['t', 'email']);
      return { t: 'about', email: text(parsed['email'], EMAIL_CAP) };
    case 'options':
      onlyKeys(parsed, ['t', 'phone']);
      if (typeof parsed['phone'] !== 'boolean') {
        throw new ProtocolError('a message field that is not yes or no arrived');
      }
      return { t: 'options', phone: parsed['phone'] };
    case 'closing':
      onlyKeys(parsed, ['t']);
      return { t: 'closing' };
    default:
      throw new ProtocolError('a message of an unknown kind arrived');
  }
}

export function encodeToWindow(message: ToWindow): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message));
}

// The rows the install screen shows, in the order the stages run.
export const INSTALL_STAGE_ORDER: readonly InstallStage[] = [
  'download',
  'install',
  'shortcuts',
  'update',
  'private',
  'open',
  'phone',
];
