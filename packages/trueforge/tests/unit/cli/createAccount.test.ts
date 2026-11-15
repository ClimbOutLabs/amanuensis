import { createLocalUser, verifyLocalSignIn } from '../../../src/auth/localSignIn';
import { runCreateAccount, type CreateAccountDeps } from '../../../src/cli/createAccount';
import { fakeIo } from './fakeIo';
import { MemoryLocalUserStore } from './memoryLocalUserStore';

const EMAIL = 'owner@example.com';
const PASSWORD = 'a long enough password';

function setup(
  answers: { email: string; password: string; confirm: string } = {
    email: EMAIL,
    password: PASSWORD,
    confirm: PASSWORD,
  },
) {
  const store = new MemoryLocalUserStore();
  let asked = 0;
  const deps: CreateAccountDeps = {
    openStore: () => Promise.resolve({ store, close: () => Promise.resolve() }),
    readAccount: () => {
      asked += 1;
      return Promise.resolve(answers);
    },
  };
  return { store, deps, timesAsked: () => asked };
}

describe('create-account', () => {
  it('stores the one sign-in, and that email and password then sign in', async () => {
    const { store, deps } = setup();
    const io = fakeIo();

    const code = await runCreateAccount({ args: [], io, deps });

    expect(code).toBe(0);
    expect(io.err.join('')).toContain('Your sign-in is set up.');
    await expect(verifyLocalSignIn({ store, email: EMAIL, password: PASSWORD })).resolves.toBeDefined();
  });

  it('refuses when a sign-in already exists, without asking and without changing it', async () => {
    const { store, deps, timesAsked } = setup({ email: 'other@example.com', password: PASSWORD, confirm: PASSWORD });
    await createLocalUser({ store, email: EMAIL, password: PASSWORD });
    const before = await store.getUser();
    const io = fakeIo();

    const code = await runCreateAccount({ args: [], io, deps });

    expect(code).toBe(1);
    expect(io.err.join('')).toContain('Your sign-in is already set up.');
    expect(timesAsked()).toBe(0);
    await expect(store.getUser()).resolves.toEqual(before);
  });

  it('with --if-missing, does nothing and succeeds when the sign-in exists', async () => {
    const { store, deps, timesAsked } = setup();
    await createLocalUser({ store, email: EMAIL, password: PASSWORD });
    const io = fakeIo();

    const code = await runCreateAccount({ args: ['--if-missing'], io, deps });

    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    expect(timesAsked()).toBe(0);
  });

  it('with --if-missing, asks when no sign-in exists yet', async () => {
    const { store, deps, timesAsked } = setup();

    const code = await runCreateAccount({ args: ['--if-missing'], io: fakeIo(), deps });

    expect(code).toBe(0);
    expect(timesAsked()).toBe(1);
    await expect(store.getUser()).resolves.toBeDefined();
  });

  it('refuses when the two passwords differ, and stores nothing', async () => {
    const { store, deps } = setup({ email: EMAIL, password: PASSWORD, confirm: 'not the same password' });
    const io = fakeIo();

    const code = await runCreateAccount({ args: [], io, deps });

    expect(code).toBe(1);
    expect(io.err.join('')).toContain('The two passwords do not match');
    await expect(store.getUser()).resolves.toBeUndefined();
  });

  it('refuses a password that is too short and an address that is not an email', async () => {
    const short = setup({ email: EMAIL, password: 'short', confirm: 'short' });
    const shortIo = fakeIo();
    expect(await runCreateAccount({ args: [], io: shortIo, deps: short.deps })).toBe(1);
    expect(shortIo.err.join('')).toContain('Use at least 8 characters for the password.');

    const notEmail = setup({ email: 'owner', password: PASSWORD, confirm: PASSWORD });
    const notEmailIo = fakeIo();
    expect(await runCreateAccount({ args: [], io: notEmailIo, deps: notEmail.deps })).toBe(1);
    expect(notEmailIo.err.join('')).toContain('That does not look like an email address.');
    await expect(notEmail.store.getUser()).resolves.toBeUndefined();
  });

  it('with nothing to read, says which command to run in a terminal', async () => {
    const { store, deps } = setup({ email: '', password: '', confirm: '' });
    const io = fakeIo();

    const code = await runCreateAccount({ args: ['--if-missing'], io, deps });

    expect(code).toBe(1);
    expect(io.err.join('')).toContain('npx amanuensis --create-account');
    await expect(store.getUser()).resolves.toBeUndefined();
  });

  it('refuses options it does not know', async () => {
    const { deps } = setup();
    const io = fakeIo();

    expect(await runCreateAccount({ args: ['--email', EMAIL], io, deps })).toBe(2);
    expect(io.err.join('')).toContain('This command takes only --if-missing.');
  });
});
