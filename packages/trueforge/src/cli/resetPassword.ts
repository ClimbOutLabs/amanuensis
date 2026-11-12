import {
  LOCAL_NO_SIGN_IN_MESSAGE,
  LOCAL_PASSWORDS_DO_NOT_MATCH_MESSAGE,
  resetLocalUserPassword,
} from '../auth/localSignIn';
import type { ILocalUserStore } from '../db/localUserStore';
import type { Command } from './command';

const USAGE = `Usage: aman reset-password

Sets a new password for the local sign-in on this computer. Run it on the machine
that runs Aman, while Aman is stopped. It asks for the new password twice and does
not show what you type. The npx form is: npx amanuensis --reset-password

To check that Aman is stopped, it looks on the port Aman is set to use. If you
start Aman with a different port, pass the same one here: the npx form is
npx amanuensis --reset-password --port <n>, with your port in place of <n>.
`;

export interface ResetPasswordDeps {
  /** True when the server answers on its own address; a reset under a running server is refused. */
  serverRunning(): Promise<boolean>;
  /** Opens the instance's local user store; only called once the command line has been accepted. */
  openStore(): Promise<{ store: ILocalUserStore; close: () => Promise<void> }>;
  /** The new password typed twice: hidden on a terminal, two lines when piped in. */
  readPasswordPair(): Promise<{ password: string; confirm: string }>;
}

/** Server config validates the environment on import, so the real wiring loads it only when asked. */
const lazyDeps: ResetPasswordDeps = {
  serverRunning: async () => (await import('./resetPasswordRuntime')).serverRunning(),
  openStore: async () => (await import('./resetPasswordRuntime')).openLocalUserStore(),
  readPasswordPair: async () => (await import('./resetPasswordRuntime')).readPasswordPair(),
};

export async function runResetPassword({
  args,
  io,
  deps,
}: {
  args: readonly string[];
  io: { stderr(text: string): Promise<void> };
  deps: ResetPasswordDeps;
}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    await io.stderr(USAGE);
    return 0;
  }
  if (args.length > 0) {
    await io.stderr(`This command takes no options.\n\n${USAGE}`);
    return 2;
  }
  if (await deps.serverRunning()) {
    await io.stderr('Aman is running. Stop it first, then run this again.\n');
    return 1;
  }
  const { store, close } = await deps.openStore();
  try {
    const user = await store.getUser();
    if (user === undefined) {
      await io.stderr(`${LOCAL_NO_SIGN_IN_MESSAGE}\n`);
      return 1;
    }
    const pair = await deps.readPasswordPair();
    if (pair.password !== pair.confirm) {
      await io.stderr(`${LOCAL_PASSWORDS_DO_NOT_MATCH_MESSAGE}\n`);
      return 1;
    }
    const result = await resetLocalUserPassword({ store, new_password: pair.password });
    if (!result.ok) {
      await io.stderr(`${result.message}\n`);
      return 1;
    }
    await io.stderr('Your password is reset. Start Aman and sign in with the new password.\n');
    return 0;
  } finally {
    await close();
  }
}

/** `aman reset-password`: the terminal form of the login page's reset hint. */
export const resetPassword: Command = ({ args, io }) => runResetPassword({ args, io, deps: lazyDeps });
