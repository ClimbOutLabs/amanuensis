import {
  installEmailProblem,
  installWithAnswers,
  prepareInstall,
  type InstallDeps,
  type InstallProgress,
  type InstallStage,
  type WindowOutcome,
} from '../commands/install.ts';
import {
  INSTALL_PASSWORD_MISMATCH_LINE,
  installPasswordProblem,
  problemText,
  WINDOW_ABOUT_LINES,
  WINDOW_ABOUT_TITLE,
  WINDOW_AGAIN_LABEL,
  WINDOW_BACK,
  WINDOW_BRAND,
  WINDOW_CHECK_DOCKER_ROW,
  WINDOW_CHECK_LINES,
  WINDOW_CHECK_MEMORY_ROW,
  WINDOW_CHECK_READY_LINE,
  WINDOW_CHECK_TITLE,
  WINDOW_CLOSE,
  WINDOW_CLOSE_QUESTION,
  WINDOW_CLOSED_EARLY,
  WINDOW_CLOSED_LINE,
  WINDOW_DETAILS,
  WINDOW_DONE_LINES,
  WINDOW_DONE_TITLE,
  WINDOW_EMAIL_LABEL,
  WINDOW_INSTALL,
  WINDOW_INSTALL_LINES,
  WINDOW_INSTALL_TITLE,
  WINDOW_KEEP_LINE,
  WINDOW_MARK_LABELS,
  WINDOW_NEXT,
  WINDOW_OPTIONS_LINES,
  WINDOW_OPTIONS_TITLE,
  WINDOW_PASSWORD_LABEL,
  WINDOW_PHONE_NO,
  WINDOW_PHONE_YES,
  WINDOW_REVIEW_LINES,
  WINDOW_REVIEW_NO_PHONE_ROW,
  WINDOW_REVIEW_PHONE_ROW,
  WINDOW_REVIEW_ROWS,
  WINDOW_REVIEW_TITLE,
  WINDOW_RULE_LABELS,
  WINDOW_STAGE_ROWS,
  WINDOW_STEPS,
  WINDOW_STOPPED_LINES,
  WINDOW_STOPPED_TITLE,
  WINDOW_TITLE,
  WINDOW_TRY_AGAIN,
  WINDOW_WELCOME_LINES,
  WINDOW_WELCOME_TITLE,
  windowReviewEmailRow,
} from '../messages.ts';
import {
  INSTALL_STAGE_ORDER,
  type FromWindow,
  type RowMark,
  type ScreenName,
  type ScreenRow,
  type ToWindow,
  type WindowWords,
} from './protocol.ts';

// What arrives from the window: a message, a password, the window
// closing its end, or bytes that broke the rules of the channel.
export type WindowEvent =
  | { kind: 'message'; message: FromWindow }
  | { kind: 'password'; bytes: Uint8Array }
  | { kind: 'gone' }
  | { kind: 'broken' };

export interface WindowChannel {
  // Does nothing once the window is gone.
  send: (message: ToWindow) => void;
  // The next thing from the window. Once it is gone, every call says so.
  next: () => Promise<WindowEvent>;
  // Ends the window and wipes anything still held for it.
  close: () => void;
}

export interface WindowSessionOptions {
  channel: WindowChannel;
  // What was started, to compare with what the window says it is.
  powershellPath: string;
  windowsDir: string;
  // Resolves when the window has had long enough to say hello.
  helloWait: () => Promise<void>;
}

// The longest line shown under Show details; a longer one is cut.
const LINE_CAP = 2000;

const WORDS: WindowWords = {
  windowTitle: WINDOW_TITLE,
  brand: WINDOW_BRAND,
  steps: WINDOW_STEPS,
  emailLabel: WINDOW_EMAIL_LABEL,
  passwordLabel: WINDOW_PASSWORD_LABEL,
  ruleLabels: WINDOW_RULE_LABELS,
  againLabel: WINDOW_AGAIN_LABEL,
  keepLine: WINDOW_KEEP_LINE,
  phoneYes: WINDOW_PHONE_YES,
  phoneNo: WINDOW_PHONE_NO,
  detailsLabel: WINDOW_DETAILS,
  markLabels: WINDOW_MARK_LABELS,
  closeTitle: WINDOW_TITLE,
  closeQuestion: WINDOW_CLOSE_QUESTION,
};

function samePath(a: string, b: string): boolean {
  const tidy = (path: string): string => path.replace(/[\\/]+$/, '').toLowerCase();
  return tidy(a) === tidy(b);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

// Holds the one read that is waiting on the window, so a read started
// while a long step runs is not lost when the step ends first.
class Inbox {
  private readonly channel: WindowChannel;
  private pending: Promise<WindowEvent> | null = null;

  constructor(channel: WindowChannel) {
    this.channel = channel;
  }

  peek(): Promise<WindowEvent> {
    this.pending ??= this.channel.next();
    return this.pending;
  }

  async take(): Promise<WindowEvent> {
    const event = await this.peek();
    this.pending = null;
    return event;
  }
}

type Ending = 'closed' | 'lost';

// The first install, asked and shown in the setup window. The program
// keeps the order of the screens: the window is told what to show, and
// anything it sends that the current screen does not allow ends it.
// Before the install starts, a window that is lost hands over to the
// questions on the terminal and a window the person closed ends the
// setup. Once the install has started it runs to its end either way.
export async function runWindowInstall(deps: InstallDeps, options: WindowSessionOptions): Promise<WindowOutcome> {
  const { channel } = options;
  const inbox = new Inbox(channel);
  // Kept in an object because the steps that change it run while this
  // function waits.
  const state: { ending: Ending | null } = { ending: null };
  const ended = (): Ending | null => state.ending;
  let password: Uint8Array | null = null;
  let lastLine = '';
  const marks = new Map<string, RowMark>();

  const send = (message: ToWindow): void => {
    if (ended() === null) {
      channel.send(message);
    }
  };
  const end = (how: Ending): void => {
    state.ending ??= how;
    channel.close();
  };
  const print = (line: string): void => {
    deps.print(line);
    lastLine = line;
    send({ t: 'line', text: line.length > LINE_CAP ? line.slice(0, LINE_CAP) : line });
  };
  const report = (progress: InstallProgress): void => {
    const mark: RowMark = progress.state === 'started' ? 'doing' : progress.state;
    marks.set(progress.stage, mark);
    send({ t: 'row', id: progress.stage, mark });
  };
  const windowDeps: InstallDeps = { ...deps, print, report };

  const rowsFor = (stages: readonly InstallStage[], labels: Readonly<Record<string, string>>): ScreenRow[] =>
    stages.map(stage => ({ id: stage, label: labels[stage] ?? stage, mark: marks.get(stage) ?? 'todo' }));

  const show = (screen: {
    name: ScreenName;
    title: string;
    lines: readonly string[];
    rows?: readonly ScreenRow[];
    panel?: 'none' | 'about' | 'options';
    details?: boolean;
    next?: string;
    back?: string;
    confirmClose?: boolean;
  }): void => {
    const order: readonly ScreenName[] = ['welcome', 'check', 'about', 'options', 'review', 'install', 'done'];
    const step = screen.name === 'stopped' ? order.indexOf('install') : order.indexOf(screen.name);
    send({
      t: 'screen',
      name: screen.name,
      step,
      title: screen.title,
      lines: screen.lines,
      rows: screen.rows ?? [],
      panel: screen.panel ?? 'none',
      details: screen.details ?? false,
      next: screen.next ?? null,
      back: screen.back ?? null,
      confirmClose: screen.confirmClose ?? false,
    });
  };

  // The next thing the person did, or null when the window has ended.
  const take = async (): Promise<FromWindow | { t: 'password'; bytes: Uint8Array } | null> => {
    if (ended() !== null) {
      return null;
    }
    const event = await inbox.take();
    if (event.kind === 'message') {
      if (event.message.t === 'closing') {
        end('closed');
        return null;
      }
      return event.message;
    }
    if (event.kind === 'password') {
      return { t: 'password', bytes: event.bytes };
    }
    end('lost');
    return null;
  };

  // Something the current screen does not allow arrived.
  const refuse = (event: FromWindow | { t: 'password'; bytes: Uint8Array }): void => {
    if (event.t === 'password') {
      event.bytes.fill(0);
    }
    end('lost');
  };

  // Runs a long step while watching the window: the buttons are off,
  // so the only thing it may send is that it is closing.
  const whileWorking = async <T>(work: Promise<T>): Promise<T> => {
    const finished = work.then(
      () => 'finished' as const,
      () => 'finished' as const,
    );
    while (ended() === null) {
      const first = await Promise.race([finished, inbox.peek().then(() => 'event' as const)]);
      if (first === 'finished') {
        break;
      }
      const event = await take();
      if (event !== null) {
        refuse(event);
      }
    }
    return work;
  };

  const beforeInstall = (): WindowOutcome => {
    if (ended() === 'closed') {
      deps.print(problemText(WINDOW_CLOSED_EARLY));
      return { kind: 'finished', code: 1 };
    }
    return { kind: 'fallback' };
  };

  try {
    // The window says what it is before anything is shown in it.
    const hello = await Promise.race([inbox.peek().then(() => 'event' as const), options.helloWait()]);
    const first = hello === 'event' ? await take() : null;
    if (
      first?.t !== 'hello' ||
      first.languageMode !== 'FullLanguage' ||
      !samePath(first.modulePath, options.powershellPath) ||
      !samePath(first.windowsDir, options.windowsDir) ||
      !samePath(first.systemDir, `${options.windowsDir}\\System32`)
    ) {
      if (first?.t === 'password') {
        first.bytes.fill(0);
      }
      end('lost');
      return { kind: 'fallback' };
    }
    send({ t: 'init', words: WORDS });

    const resumed = await deps.jobs.runOnceResumePending().catch(() => false);
    if (!resumed) {
      show({ name: 'welcome', title: WINDOW_WELCOME_TITLE, lines: WINDOW_WELCOME_LINES, next: WINDOW_NEXT });
      const event = await take();
      if (event === null) {
        return beforeInstall();
      }
      if (event.t !== 'next') {
        refuse(event);
        return { kind: 'fallback' };
      }
    }

    const checkLabels = { docker: WINDOW_CHECK_DOCKER_ROW, checks: WINDOW_CHECK_MEMORY_ROW };
    const checkStages: readonly InstallStage[] = ['docker', 'checks'];
    for (;;) {
      marks.clear();
      show({
        name: 'check',
        title: WINDOW_CHECK_TITLE,
        lines: WINDOW_CHECK_LINES,
        rows: rowsFor(checkStages, checkLabels),
        details: true,
      });
      const prepared = await whileWorking(prepareInstall(windowDeps));
      if (ended() !== null) {
        return beforeInstall();
      }
      if (prepared === 'installed') {
        send({ t: 'end' });
        end('closed');
        return { kind: 'installed' };
      }
      const ready = prepared === 'fresh';
      show({
        name: 'check',
        title: WINDOW_CHECK_TITLE,
        lines: ready ? [WINDOW_CHECK_READY_LINE] : WINDOW_CHECK_LINES,
        rows: rowsFor(checkStages, checkLabels),
        details: true,
        next: ready ? WINDOW_NEXT : WINDOW_TRY_AGAIN,
      });
      if (!ready) {
        send({ t: 'problem', text: lastLine });
      }
      const event = await take();
      if (event === null) {
        return beforeInstall();
      }
      if (event.t !== 'next') {
        refuse(event);
        return { kind: 'fallback' };
      }
      if (ready) {
        break;
      }
    }

    let email = '';
    let phone = false;
    let screen: 'about' | 'options' | 'review' = 'about';
    for (;;) {
      if (screen === 'about') {
        password?.fill(0);
        password = null;
        show({
          name: 'about',
          title: WINDOW_ABOUT_TITLE,
          lines: WINDOW_ABOUT_LINES,
          panel: 'about',
          next: WINDOW_NEXT,
        });
        // The About you screen sends the password, the password typed
        // again, and then the email, in that order and nothing else.
        while (password === null) {
          const typed = await take();
          if (typed === null) {
            return beforeInstall();
          }
          if (typed.t !== 'password') {
            refuse(typed);
            return { kind: 'fallback' };
          }
          const again = await take();
          if (again?.t !== 'password') {
            typed.bytes.fill(0);
            if (again !== null) {
              refuse(again);
              return { kind: 'fallback' };
            }
            return beforeInstall();
          }
          const about = await take();
          if (about?.t !== 'about') {
            typed.bytes.fill(0);
            again.bytes.fill(0);
            if (about !== null) {
              refuse(about);
              return { kind: 'fallback' };
            }
            return beforeInstall();
          }
          const same = sameBytes(typed.bytes, again.bytes);
          again.bytes.fill(0);
          const problem =
            installEmailProblem(about.email) ??
            installPasswordProblem(typed.bytes) ??
            (same ? null : INSTALL_PASSWORD_MISMATCH_LINE);
          if (problem !== null) {
            typed.bytes.fill(0);
            send({ t: 'problem', text: problem });
            send({ t: 'buttons', next: true, back: false });
            continue;
          }
          email = about.email.trim();
          password = typed.bytes;
        }
        screen = 'options';
        continue;
      }
      if (screen === 'options') {
        show({
          name: 'options',
          title: WINDOW_OPTIONS_TITLE,
          lines: WINDOW_OPTIONS_LINES,
          panel: 'options',
          next: WINDOW_NEXT,
          back: WINDOW_BACK,
        });
        const event = await take();
        if (event === null) {
          return beforeInstall();
        }
        if (event.t === 'back') {
          screen = 'about';
          continue;
        }
        if (event.t !== 'options') {
          refuse(event);
          return { kind: 'fallback' };
        }
        phone = event.phone;
        screen = 'review';
        continue;
      }
      const reviewLabels = [
        windowReviewEmailRow(email),
        ...WINDOW_REVIEW_ROWS,
        phone ? WINDOW_REVIEW_PHONE_ROW : WINDOW_REVIEW_NO_PHONE_ROW,
      ];
      show({
        name: 'review',
        title: WINDOW_REVIEW_TITLE,
        lines: WINDOW_REVIEW_LINES,
        rows: reviewLabels.map((label, index) => ({ id: `review-${String(index)}`, label, mark: 'todo' })),
        next: WINDOW_INSTALL,
        back: WINDOW_BACK,
      });
      const event = await take();
      if (event === null) {
        return beforeInstall();
      }
      if (event.t === 'back') {
        screen = 'options';
        continue;
      }
      if (event.t !== 'next') {
        refuse(event);
        return { kind: 'fallback' };
      }
      break;
    }

    if (password === null) {
      return beforeInstall();
    }
    marks.clear();
    const stages = INSTALL_STAGE_ORDER.filter(stage => stage !== 'phone' || phone);
    show({
      name: 'install',
      title: WINDOW_INSTALL_TITLE,
      lines: WINDOW_INSTALL_LINES,
      rows: rowsFor(stages, WINDOW_STAGE_ROWS),
      details: true,
      confirmClose: true,
    });
    const answers = { email, password, phone };
    password = null;
    const install = installWithAnswers(windowDeps, answers);
    const code = await whileWorking(
      install.finally(() => {
        answers.password.fill(0);
      }),
    );
    if (ended() !== null) {
      deps.print(WINDOW_CLOSED_LINE);
      // The window is gone, and the install still runs to its end.
      return { kind: 'finished', code: await install };
    }
    if (code === 0) {
      show({ name: 'done', title: WINDOW_DONE_TITLE, lines: WINDOW_DONE_LINES, next: WINDOW_CLOSE });
    } else {
      show({
        name: 'stopped',
        title: WINDOW_STOPPED_TITLE,
        lines: WINDOW_STOPPED_LINES,
        rows: rowsFor(stages, WINDOW_STAGE_ROWS),
        details: true,
        next: WINDOW_CLOSE,
      });
      send({ t: 'problem', text: lastLine });
    }
    const last = await take();
    if (last?.t === 'password') {
      last.bytes.fill(0);
    }
    send({ t: 'end' });
    end('closed');
    return { kind: 'finished', code };
  } finally {
    password?.fill(0);
    channel.close();
  }
}
