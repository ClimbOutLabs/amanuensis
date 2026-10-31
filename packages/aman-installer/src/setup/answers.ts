import {
  PASSWORD_LACK_LENGTH,
  PASSWORD_LACK_NUMBER,
  PASSWORD_LACK_SYMBOL,
  PASSWORD_TOO_LONG_LINE,
} from '../messages.ts';

// The wizard's answers: what the person typed and chose on the About you
// and Options screens. Secrets are not part of this shape; they travel in
// SetupSecrets and reach the installer only on its stdin.
export interface AdvancedAnswers {
  emailProvider: string;
  emailAddress: string;
  emailImapHost: string;
  emailImapPort: string;
  emailSmtpHost: string;
  emailSmtpPort: string;
  calendarProvider: string;
  calendarEmail: string;
  calendarUrl: string;
  calendarUser: string;
  tokenFactoryModel: string;
  tokenFactoryDailyCap: string;
}

export interface SetupAnswers {
  email: string;
  yourName: string;
  backups: 'daily' | 'off';
  reach: 'local' | 'network';
  // Set on the checks screen when Docker is missing on Linux and the
  // person chose to let the installer install it.
  installDocker: boolean;
  advanced: AdvancedAnswers;
}

// The secrets of one run, kept apart from the answers on purpose: the
// answers are written to the run record so a later setup can pick the run
// up again, and a secret must never be written anywhere.
export interface SetupSecrets {
  password: string;
  emailPassword: string;
  calendarPassword: string;
  tokenFactoryKey: string;
}

export const EMPTY_ADVANCED: AdvancedAnswers = {
  emailProvider: '',
  emailAddress: '',
  emailImapHost: '',
  emailImapPort: '',
  emailSmtpHost: '',
  emailSmtpPort: '',
  calendarProvider: '',
  calendarEmail: '',
  calendarUrl: '',
  calendarUser: '',
  tokenFactoryModel: '',
  tokenFactoryDailyCap: '',
};

export const EMPTY_SECRETS: SetupSecrets = { password: '', emailPassword: '', calendarPassword: '', tokenFactoryKey: '' };

function emailGiven(answers: SetupAnswers): boolean {
  return answers.advanced.emailProvider !== '' && answers.advanced.emailAddress !== '';
}

function calendarGiven(answers: SetupAnswers): boolean {
  return answers.advanced.calendarProvider !== '' && answers.advanced.calendarEmail !== '';
}

function tokenFactoryGiven(secrets: SetupSecrets): boolean {
  return secrets.tokenFactoryKey !== '';
}

// The flags the email section adds, in the installer's own names. The app
// password itself is never a flag; it goes on stdin.
function emailArgs(answers: SetupAnswers): string[] {
  if (!emailGiven(answers)) {
    return [];
  }
  const a = answers.advanced;
  const args = ['--email-provider', a.emailProvider, '--email-address', a.emailAddress];
  if (a.emailImapHost !== '') args.push('--email-imap-host', a.emailImapHost);
  if (a.emailImapPort !== '') args.push('--email-imap-port', a.emailImapPort);
  if (a.emailSmtpHost !== '') args.push('--email-smtp-host', a.emailSmtpHost);
  if (a.emailSmtpPort !== '') args.push('--email-smtp-port', a.emailSmtpPort);
  args.push('--email-password-stdin');
  return args;
}

function calendarArgs(answers: SetupAnswers): string[] {
  if (!calendarGiven(answers)) {
    return [];
  }
  const a = answers.advanced;
  const args = ['--calendar-provider', a.calendarProvider, '--calendar-email', a.calendarEmail];
  if (a.calendarUrl !== '') args.push('--calendar-url', a.calendarUrl);
  if (a.calendarUser !== '') args.push('--calendar-user', a.calendarUser);
  args.push('--calendar-password-stdin');
  return args;
}

function tokenFactoryArgs(answers: SetupAnswers, secrets: SetupSecrets): string[] {
  if (!tokenFactoryGiven(secrets)) {
    return [];
  }
  const args = ['--token-factory-key-stdin'];
  if (answers.advanced.tokenFactoryModel !== '') args.push('--token-factory-model', answers.advanced.tokenFactoryModel);
  if (answers.advanced.tokenFactoryDailyCap !== '') {
    args.push('--token-factory-daily-cap', answers.advanced.tokenFactoryDailyCap);
  }
  return args;
}

// The installer's arguments for one run of the wizard, shared by the dry
// run that makes the plan and the real run. The wizard's Install button is
// the person's yes, so --yes stands in for the installer's own "Go ahead?"
// question; the steps that change the computer still need their own flags,
// which the reviewed plan decides (see planAdminArgs). cloudVm says the
// computer is a cloud server, where the installer's own guard keeps a new
// instance on this computer unless --home-network records the person's
// choice; at home the default already opens the network, so the flag is
// left off there.
export function installArgs(options: {
  answers: SetupAnswers;
  secrets: SetupSecrets;
  cloudVm: boolean;
  eventsFd: number;
  dryRun: boolean;
  withPassword: boolean;
}): string[] {
  const { answers, secrets, cloudVm, eventsFd, dryRun, withPassword } = options;
  const args: string[] = [];
  if (dryRun) {
    args.push('--dry-run', '--verbose');
  } else {
    args.push('--yes');
  }
  args.push('--events', String(eventsFd));
  args.push('--email', answers.email);
  if (answers.yourName !== '') {
    args.push('--your-name', answers.yourName);
  }
  args.push('--backups', answers.backups);
  if (answers.reach === 'local') {
    args.push('--local-only');
  } else if (cloudVm) {
    args.push('--home-network');
  }
  if (answers.installDocker) {
    args.push('--install-docker');
  }
  args.push(...emailArgs(answers));
  args.push(...calendarArgs(answers));
  args.push(...tokenFactoryArgs(answers, secrets));
  if (withPassword) {
    args.push('--password-stdin');
  }
  return args;
}

// The flags a reviewed plan asks for, one per step the plan marks as
// needing admin: the wizard shows those steps before the Install button,
// so the click is the consent the installer's consent_root asks for, and
// the matching flag is how a run records it.
export function planAdminArgs(planRowTexts: readonly string[]): string[] {
  const args: string[] = [];
  for (const text of planRowTexts) {
    if (text.startsWith('Install Docker Engine') && !args.includes('--install-docker')) {
      args.push('--install-docker');
    }
    if (text.startsWith('Give ') && text.includes('access to Docker') && !args.includes('--add-docker-group')) {
      args.push('--add-docker-group');
    }
    if (text.startsWith('Set up the sandbox on this computer') && !args.includes('--sandbox-root')) {
      args.push('--sandbox-root');
    }
    if (
      (text.startsWith('Install Caddy') || text.startsWith('Apply the Caddyfile')) &&
      !args.includes('--tls-root')
    ) {
      args.push('--tls-root');
    }
  }
  return args;
}

// The lines the installer reads from stdin, one per -stdin flag the run
// carries, in the installer's fixed order: sign-in password, Token Factory
// key, calendar app password, email app password. A line is present only
// when its flag is, exactly as install.sh's usage writes down.
export function stdinLines(options: {
  answers: SetupAnswers;
  secrets: SetupSecrets;
  withPassword: boolean;
}): string[] {
  const { answers, secrets, withPassword } = options;
  const lines: string[] = [];
  if (withPassword) {
    lines.push(secrets.password);
  }
  if (tokenFactoryGiven(secrets)) {
    lines.push(secrets.tokenFactoryKey);
  }
  if (calendarGiven(answers)) {
    lines.push(secrets.calendarPassword);
  }
  if (emailGiven(answers)) {
    lines.push(secrets.emailPassword);
  }
  return lines;
}

// The installer's password rule, mirrored for the wizard's live feedback
// (password_problem in installer/lib/common.sh): at least 8 characters, a
// number and a symbol, at most 72 bytes. The installer judges the password
// itself when it is given it, so this mirror only shapes what the person
// sees while typing. Returns the one sentence naming what is missing, or
// an empty string when the password can be used.
export function passwordProblem(password: string): string {
  const bytes = new TextEncoder().encode(password).length;
  if (bytes > 72) {
    return PASSWORD_TOO_LONG_LINE;
  }
  const missing: string[] = [];
  if (bytes < 8) {
    missing.push(PASSWORD_LACK_LENGTH);
  }
  if (!/[0-9]/.test(password)) {
    missing.push(PASSWORD_LACK_NUMBER);
  }
  if (!/[^A-Za-z0-9\s]/.test(password)) {
    missing.push(PASSWORD_LACK_SYMBOL);
  }
  if (missing.length === 0) {
    return '';
  }
  if (missing.length === 1) {
    return `That password still needs ${missing[0] ?? ''}.`;
  }
  if (missing.length === 2) {
    return `That password still needs ${missing[0] ?? ''} and ${missing[1] ?? ''}.`;
  }
  return `That password still needs ${missing[0] ?? ''}, ${missing[1] ?? ''} and ${missing[2] ?? ''}.`;
}

// The name the About you screen offers first: the part of the email
// before the @, which is the installer's own default.
export function defaultNameFromEmail(email: string): string {
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAdvancedAnswers(value: unknown): value is AdvancedAnswers {
  if (!isRecord(value)) {
    return false;
  }
  const keys: (keyof AdvancedAnswers)[] = [
    'emailProvider',
    'emailAddress',
    'emailImapHost',
    'emailImapPort',
    'emailSmtpHost',
    'emailSmtpPort',
    'calendarProvider',
    'calendarEmail',
    'calendarUrl',
    'calendarUser',
    'tokenFactoryModel',
    'tokenFactoryDailyCap',
  ];
  return keys.every(key => typeof value[key] === 'string');
}

// Whether a value read back from the wizard's own run record is a whole
// set of answers. The record is the wizard's scratch, but it is still
// read as untrusted data: anything misshapen is not answers.
export function isSetupAnswers(value: unknown): value is SetupAnswers {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['email'] === 'string' &&
    typeof value['yourName'] === 'string' &&
    (value['backups'] === 'daily' || value['backups'] === 'off') &&
    (value['reach'] === 'local' || value['reach'] === 'network') &&
    typeof value['installDocker'] === 'boolean' &&
    isAdvancedAnswers(value['advanced'])
  );
}

// Reads a set of answers out of a JSON body the page sent, field by
// field, with the empty advanced set for anything absent. Returns null
// when the shape is wrong in a way the wizard cannot work with.
export function answersFromJson(value: unknown): SetupAnswers | null {
  if (!isRecord(value)) {
    return null;
  }
  const advanced = isAdvancedAnswers(value['advanced']) ? value['advanced'] : EMPTY_ADVANCED;
  const candidate: SetupAnswers = {
    email: typeof value['email'] === 'string' ? value['email'] : '',
    yourName: typeof value['yourName'] === 'string' ? value['yourName'] : '',
    backups: value['backups'] === 'off' ? 'off' : 'daily',
    reach: value['reach'] === 'local' ? 'local' : 'network',
    installDocker: value['installDocker'] === true,
    advanced,
  };
  return isSetupAnswers(candidate) ? candidate : null;
}

// Reads the secrets out of a JSON body the page sent. The result lives
// only in the server's memory and is dropped once the run has read it.
export function secretsFromJson(value: unknown): SetupSecrets {
  if (!isRecord(value)) {
    return { ...EMPTY_SECRETS };
  }
  return {
    password: typeof value['password'] === 'string' ? value['password'] : '',
    emailPassword: typeof value['emailPassword'] === 'string' ? value['emailPassword'] : '',
    calendarPassword: typeof value['calendarPassword'] === 'string' ? value['calendarPassword'] : '',
    tokenFactoryKey: typeof value['tokenFactoryKey'] === 'string' ? value['tokenFactoryKey'] : '',
  };
}

// True when the computer's hardware names a well-known cloud provider,
// the same list the installer's network_cloud_vm reads from the same
// files, so the Options screen can put its default where the installer's
// cloud guard would put it.
export function cloudVmFromHardwareText(text: string): boolean {
  const lower = text.toLowerCase();
  const names = [
    'amazon ec2',
    'google compute engine',
    'digitalocean',
    'hetzner',
    'vultr',
    'linode',
    'akamai',
    'openstack',
    'oraclecloud',
    'alibaba cloud',
    'tencent cloud',
    '7783-7084-3265-9085-8269-3286-77',
  ];
  return names.some(name => lower.includes(name));
}
