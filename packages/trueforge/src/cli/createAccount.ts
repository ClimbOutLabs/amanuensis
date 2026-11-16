import { createLocalUser, LOCAL_PASSWORDS_DO_NOT_MATCH_MESSAGE } from '../auth/localSignIn';
import type { ILocalUserStore } from '../db/localUserStore';
import type { Command } from './command';

const USAGE = `Usage: aman create-account [--if-missing]

Creates the one local sign-in for Aman on this computer: your email address and a
password. Run it on the machine that runs Aman. It asks for the email, then the
password twice, and does not show the password while you type. There is only ever
one sign-in; to change its password later, use reset-password.

The npx form is: npx amanuensis --create-account. Starting Aman with npx runs this
for you the first time.

  --if-missing   Do nothing when the sign-in already exists.
`;

const ACCOUNT_CREATED_MESSAGE = 'Your sign-in is set up. Open Aman and sign in with it.';
const ACCOUNT_EXISTS_MESSAGE = 'Your sign-in is already set up. To choose a new password, run reset-password instead.';
const NO_ANSWERS_MESSAGE =
  'Nothing was typed, so no sign-in was made. Run npx amanuensis --create-account in a terminal on this computer, then start Aman again.';

export interface CreateAccountDeps {
  /** Opens the instance's local user store, making the database on a first run. */
  openStore(): Promise<{ store: ILocalUserStore; close: () => Promise<void> }>;
  /** The email, then the password typed twice: the password hidden on a terminal, three lines when piped in. */
  readAccount(): Promise<{ email: string; password: string; confirm: string }>;
}

/** Server config validates the environment on import, so the real wiring loads it only when asked. */
const lazyDeps: CreateAccountDeps = {
  openStore: async () => (await import('./localSignInRuntime')).openLocalUserStore({ create: true }),
  readAccount: async () => {
    const { readAnswers } = await import('./localSignInRuntime');
    const [email = '', password = '', confirm = ''] = await readAnswers([
      { prompt: 'Email address: ', hidden: false },
      { prompt: 'Password (at least 8 characters): ', hidden: true },
      { prompt: 'Type the password again: ', hidden: true },
    ]);
    return { email, password, confirm };
  },
};

export async function runCreateAccount({
  args,
  io,
  deps,
}: {
  args: readonly string[];
  io: { stderr(text: string): Promise<void> };
  deps: CreateAccountDeps;
}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    await io.stderr(USAGE);
    return 0;
  }
  const ifMissing = args.includes('--if-missing');
  if (args.some(arg => arg !== '--if-missing')) {
    await io.stderr(`This command takes only --if-missing.\n\n${USAGE}`);
    return 2;
  }
  const { store, close } = await deps.openStore();
  try {
    if ((await store.getUser()) !== undefined) {
      if (ifMissing) {
        return 0;
      }
      await io.stderr(`${ACCOUNT_EXISTS_MESSAGE}\n`);
      return 1;
    }
    await io.stderr('Aman has no sign-in yet. Choose the email and password you will sign in with.\n');
    const answers = await deps.readAccount();
    if (answers.email.trim() === '' && answers.password === '') {
      await io.stderr(`${NO_ANSWERS_MESSAGE}\n`);
      return 1;
    }
    if (answers.password !== answers.confirm) {
      await io.stderr(`${LOCAL_PASSWORDS_DO_NOT_MATCH_MESSAGE}\n`);
      return 1;
    }
    const created = await createLocalUser({ store, email: answers.email, password: answers.password });
    if (!created.ok) {
      await io.stderr(`${created.message}\n`);
      return 1;
    }
    await io.stderr(`${ACCOUNT_CREATED_MESSAGE}\n`);
    return 0;
  } finally {
    await close();
  }
}

/** `aman create-account`: the one way the local sign-in is made, at the machine that runs Aman. */
export const createAccount: Command = ({ args, io }) => runCreateAccount({ args, io, deps: lazyDeps });
