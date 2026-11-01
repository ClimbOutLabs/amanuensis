import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  answersFromJson,
  cloudVmFromHardwareText,
  defaultNameFromEmail,
  installArgs,
  passwordProblem,
  planAdminArgs,
  secretsFromJson,
  stdinLines,
  EMPTY_ADVANCED,
  EMPTY_SECRETS,
  type SetupAnswers,
  type SetupSecrets,
} from '../../src/setup/answers.ts';
import { PASSWORD_TOO_LONG_LINE } from '../../src/messages.ts';

const BASE: SetupAnswers = {
  email: 'you@example.com',
  yourName: 'You',
  backups: 'daily',
  reach: 'network',
  installDocker: false,
  advanced: { ...EMPTY_ADVANCED },
};

function argsFor(answers: SetupAnswers, secrets: SetupSecrets, extra?: { cloudVm?: boolean; dryRun?: boolean; withPassword?: boolean }) {
  return installArgs({
    answers,
    secrets,
    cloudVm: extra?.cloudVm ?? false,
    eventsFd: 3,
    dryRun: extra?.dryRun ?? false,
    withPassword: extra?.withPassword ?? true,
  });
}

test('the basic answers map to the installer flags', () => {
  const args = argsFor(BASE, EMPTY_SECRETS);
  assert.deepEqual(args, [
    '--yes',
    '--events',
    '3',
    '--email',
    'you@example.com',
    '--your-name',
    'You',
    '--backups',
    'daily',
    '--password-stdin',
  ]);
});

test('a dry run asks for the plan and never for a password flag', () => {
  const args = argsFor(BASE, EMPTY_SECRETS, { dryRun: true, withPassword: false });
  assert.deepEqual(args.slice(0, 3), ['--dry-run', '--verbose', '--events']);
  assert.ok(!args.includes('--yes'));
  assert.ok(!args.includes('--password-stdin'));
});

test('reach maps to the reach flags, with the cloud rule', () => {
  const local = argsFor({ ...BASE, reach: 'local' }, EMPTY_SECRETS);
  assert.ok(local.includes('--local-only'));
  assert.ok(!local.includes('--home-network'));
  const homeNetwork = argsFor(BASE, EMPTY_SECRETS, { cloudVm: false });
  assert.ok(!homeNetwork.includes('--local-only'));
  assert.ok(!homeNetwork.includes('--home-network'));
  const cloudNetwork = argsFor(BASE, EMPTY_SECRETS, { cloudVm: true });
  assert.ok(cloudNetwork.includes('--home-network'));
  const cloudLocal = argsFor({ ...BASE, reach: 'local' }, EMPTY_SECRETS, { cloudVm: true });
  assert.ok(cloudLocal.includes('--local-only'));
});

test('backups off and the Docker choice map to their flags', () => {
  const args = argsFor({ ...BASE, backups: 'off', installDocker: true }, EMPTY_SECRETS);
  assert.ok(args.includes('--backups'));
  assert.equal(args[args.indexOf('--backups') + 1], 'off');
  assert.ok(args.includes('--install-docker'));
});

test('the advanced email fields map to flags and the stdin marker', () => {
  const answers: SetupAnswers = {
    ...BASE,
    advanced: {
      ...EMPTY_ADVANCED,
      emailProvider: 'icloud',
      emailAddress: 'you@icloud.com',
      emailImapHost: 'imap.mail.me.com',
      emailSmtpPort: '587',
    },
  };
  const args = argsFor(answers, EMPTY_SECRETS);
  const at = args.indexOf('--email-provider');
  assert.deepEqual(args.slice(at, at + 4), ['--email-provider', 'icloud', '--email-address', 'you@icloud.com']);
  assert.ok(args.includes('--email-imap-host'));
  assert.ok(args.includes('--email-smtp-port'));
  assert.ok(!args.includes('--email-imap-port'));
  assert.ok(!args.includes('--email-smtp-host'));
  assert.ok(args.includes('--email-password-stdin'));
});

test('email flags stay off until provider and address are both given', () => {
  const answers: SetupAnswers = { ...BASE, advanced: { ...EMPTY_ADVANCED, emailProvider: 'icloud' } };
  const args = argsFor(answers, EMPTY_SECRETS);
  assert.ok(!args.includes('--email-provider'));
  assert.ok(!args.includes('--email-password-stdin'));
});

test('the advanced calendar and Token Factory fields map to flags', () => {
  const answers: SetupAnswers = {
    ...BASE,
    advanced: {
      ...EMPTY_ADVANCED,
      calendarProvider: 'icloud',
      calendarEmail: 'you@icloud.com',
      calendarUrl: 'https://caldav.icloud.com',
      tokenFactoryModel: 'model-x',
      tokenFactoryDailyCap: '100',
    },
  };
  const args = argsFor(answers, { ...EMPTY_SECRETS, tokenFactoryKey: 'tf-key' });
  const at = args.indexOf('--calendar-provider');
  assert.deepEqual(args.slice(at, at + 4), ['--calendar-provider', 'icloud', '--calendar-email', 'you@icloud.com']);
  assert.ok(args.includes('--calendar-url'));
  assert.ok(!args.includes('--calendar-user'));
  assert.ok(args.includes('--calendar-password-stdin'));
  assert.ok(args.includes('--token-factory-key-stdin'));
  assert.deepEqual(args.slice(args.indexOf('--token-factory-model')), [
    '--token-factory-model',
    'model-x',
    '--token-factory-daily-cap',
    '100',
    '--password-stdin',
  ]);
});

test('no Token Factory flags without the key, which is itself never a flag', () => {
  const answers: SetupAnswers = { ...BASE, advanced: { ...EMPTY_ADVANCED, tokenFactoryModel: 'model-x' } };
  const args = argsFor(answers, EMPTY_SECRETS);
  assert.ok(!args.includes('--token-factory-key-stdin'));
  assert.ok(!args.includes('--token-factory-model'));
  const withKey = argsFor(BASE, { ...EMPTY_SECRETS, tokenFactoryKey: 'tf-secret' });
  assert.ok(!withKey.includes('tf-secret'));
});

test('secrets never ride in the argument list', () => {
  const secrets: SetupSecrets = {
    password: 'pw-sentinel',
    emailPassword: 'em-sentinel',
    calendarPassword: 'cal-sentinel',
    tokenFactoryKey: 'tf-sentinel',
  };
  const answers: SetupAnswers = {
    ...BASE,
    advanced: {
      ...EMPTY_ADVANCED,
      emailProvider: 'icloud',
      emailAddress: 'you@icloud.com',
      calendarProvider: 'icloud',
      calendarEmail: 'you@icloud.com',
    },
  };
  const joined = argsFor(answers, secrets).join('\n');
  for (const sentinel of Object.values(secrets)) {
    assert.ok(!joined.includes(sentinel), `secret in argv: ${sentinel}`);
  }
});

test('stdin lines come in the installer order, one per flag carried', () => {
  const secrets: SetupSecrets = {
    password: 'pw',
    emailPassword: 'em',
    calendarPassword: 'cal',
    tokenFactoryKey: 'tf',
  };
  const answers: SetupAnswers = {
    ...BASE,
    advanced: {
      ...EMPTY_ADVANCED,
      emailProvider: 'icloud',
      emailAddress: 'you@icloud.com',
      calendarProvider: 'icloud',
      calendarEmail: 'you@icloud.com',
    },
  };
  assert.deepEqual(stdinLines({ answers, secrets, withPassword: true }), ['pw', 'tf', 'cal', 'em']);
  assert.deepEqual(stdinLines({ answers, secrets, withPassword: false }), ['tf', 'cal', 'em']);
  assert.deepEqual(stdinLines({ answers: BASE, secrets, withPassword: true }), ['pw', 'tf']);
  assert.deepEqual(stdinLines({ answers: BASE, secrets: EMPTY_SECRETS, withPassword: true }), ['']);
});

test('the password rule matches the installer wording', () => {
  assert.equal(passwordProblem(''), 'That password still needs at least 8 characters, a number and a symbol, like @ # $ %.');
  assert.equal(passwordProblem('abcdefgh'), 'That password still needs a number and a symbol, like @ # $ %.');
  assert.equal(passwordProblem('abcd1234'), 'That password still needs a symbol, like @ # $ %.');
  assert.equal(passwordProblem('abcd!@#$'), 'That password still needs a number.');
  assert.equal(passwordProblem('abc123!'), 'That password still needs at least 8 characters.');
  assert.equal(passwordProblem('abcd123!'), '');
  assert.equal(passwordProblem('a'.repeat(73)), PASSWORD_TOO_LONG_LINE);
  // Bytes, not characters: 40 accented letters are 80 bytes.
  assert.equal(passwordProblem('é'.repeat(40)), PASSWORD_TOO_LONG_LINE);
  // 36 accented letters are exactly 72 bytes. The installer's symbol
  // test is [[:punct:]] under LC_ALL=C, so an accented letter is not a
  // symbol to it: the number and the symbol are both missing.
  assert.equal(passwordProblem('é'.repeat(36)), 'That password still needs a number and a symbol, like @ # $ %.');
  // A password whose only non-letter is an accented letter still needs
  // a symbol, however much it looks like one.
  assert.equal(passwordProblem('pässword1'), 'That password still needs a symbol, like @ # $ %.');
  assert.equal(passwordProblem('pässword1!'), '');
});

test('the name default is the part of the email before the @', () => {
  assert.equal(defaultNameFromEmail('ada@example.com'), 'ada');
  assert.equal(defaultNameFromEmail('ada'), '');
  assert.equal(defaultNameFromEmail('@example.com'), '');
});

test('the cloud check reads the hardware names like the installer', () => {
  assert.equal(cloudVmFromHardwareText('Amazon EC2\n'), true);
  assert.equal(cloudVmFromHardwareText('Google Compute Engine'), true);
  assert.equal(cloudVmFromHardwareText('7783-7084-3265-9085-8269-3286-77ab'), true);
  assert.equal(cloudVmFromHardwareText('Dell Inc. OptiPlex'), false);
  assert.equal(cloudVmFromHardwareText(''), false);
});

test('plan rows needing admin map to the consent flags, once each', () => {
  const args = planAdminArgs([
    'Install Docker Engine from the Docker download site',
    'Give ada access to Docker, and use it in this run right away',
    'Set up the sandbox on this computer',
    'Install Docker Engine from the Docker download site',
    'Create the folder for Aman',
  ]);
  assert.deepEqual(args, ['--install-docker', '--add-docker-group', '--sandbox-root']);
  assert.deepEqual(planAdminArgs(['Create the folder for Aman']), []);
});

test('answers and secrets read back from page JSON', () => {
  const answers = answersFromJson({
    email: 'you@example.com',
    backups: 'off',
    reach: 'local',
    advanced: { ...EMPTY_ADVANCED, emailProvider: 'icloud' },
  });
  assert.ok(answers !== null);
  assert.equal(answers.backups, 'off');
  assert.equal(answers.reach, 'local');
  assert.equal(answers.installDocker, false);
  assert.equal(answersFromJson('nope'), null);
  const secrets = secretsFromJson({ password: 'pw', tokenFactoryKey: 'tf' });
  assert.deepEqual(secrets, { password: 'pw', emailPassword: '', calendarPassword: '', tokenFactoryKey: 'tf' });
  assert.deepEqual(secretsFromJson(null), { ...EMPTY_SECRETS });
});
