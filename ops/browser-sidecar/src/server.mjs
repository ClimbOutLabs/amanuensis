// Private HTTP API in front of a headed Chromium: one persistent profile per person and one tab per
// chat, reached only through the browser gateway, which checks the app server's shared secret before
// it relays a call. Nothing here is published to the host or to any other service.
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { chromium } from 'playwright-core';

import { RefAssigner, renderSnapshot } from './snapshot.mjs';

const MAX_BODY_BYTES = 256 * 1024;
/** The largest file the live view may upload into a page: 10 MiB, sent as base64. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 64 * 1024;

/**
 * extract.mjs as one script for the page. `page.evaluate(fn)` sends only the function's own source, so
 * the helpers and tables it uses must travel with it: the whole module goes, minus its `export`s.
 */
const EXTRACT_MODULE = readFileSync(new URL('./extract.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');

const EXTRACT_SCRIPT = `(() => {\n${EXTRACT_MODULE}\nreturn extractSnapshotNodes();\n})()`;
const VIEW_SCRIPT = `(() => {\n${EXTRACT_MODULE}\nreturn viewPosition();\n})()`;

/** How long a scroll may take to come to rest before the page is read anyway. */
const SCROLL_SETTLE_MS = 1000;

/**
 * Waits in the page until a scroll has come to rest: the position holds for a few frames, after it
 * moved or after a short wait for a page that does not move (its end). The position counts the
 * window and every scroll box under the middle of the view, since the wheel scrolls whichever is there.
 */
const SCROLL_SETTLE_SCRIPT = `(async () => {
  const position = () => {
    let sum = window.scrollY;
    for (let box = document.elementFromPoint(innerWidth / 2, innerHeight / 2); box !== null; box = box.parentElement) {
      sum += box.scrollTop;
    }
    return sum;
  };
  const start = position();
  const began = performance.now();
  let last = start;
  let still = 0;
  while (performance.now() - began < ${String(SCROLL_SETTLE_MS)}) {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const now = position();
    still = now === last ? still + 1 : 0;
    last = now;
    if (still >= 3 && (now !== start || performance.now() - began > 200)) {
      return;
    }
  }
})()`;

/** A scroll's settle wait, bounded here too, so a page that stalls its own frames cannot hold the read. */
async function scrollSettled(page) {
  let timer;
  const cap = new Promise(resolve => {
    timer = setTimeout(resolve, SCROLL_SETTLE_MS + 500);
  });
  try {
    await Promise.race([page.evaluate(SCROLL_SETTLE_SCRIPT).catch(() => undefined), cap]);
  } finally {
    clearTimeout(timer);
  }
}

/** The same bundled module, ending in a read-only look at where the elements at `paths` sit in view. */
function boxesInViewScript(paths) {
  return `(() => {\n${EXTRACT_MODULE}\nreturn boxesInView(${JSON.stringify(paths)});\n})()`;
}

/** How long the model's copy of a screenshot may take to draw. */
const PICTURE_WORKER_MS = 5000;

/** The same bundled module, ending in the boxes the model's copy of a screenshot must cover. */
const MASK_BOXES_SCRIPT = `(() => {\n${EXTRACT_MODULE}\nreturn maskBoxes();\n})()`;

/**
 * Runs a read-only script in a world of its own on the tab's main frame. The page's scripts share
 * the DOM but not this world's JavaScript, so a page that hooks getBoundingClientRect or watches
 * its own functions being called cannot bend the result or tell that the shot is being taken.
 */
async function isolatedWorld(cdp) {
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id,
    worldName: 'aman-picture',
  });
  return executionContextId;
}

async function inIsolatedWorld({ cdp, executionContextId, expression }) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    contextId: executionContextId,
    returnByValue: true,
  });
  if (exceptionDetails !== undefined) {
    throw new Error('the layout read failed');
  }
  return result.value;
}

/**
 * Whether a node of a DOM.getDocument tree holds a form field anywhere below it, shadow roots
 * included. A frame or embed counts too: what it shows cannot be read here, so it is covered whole.
 */
function holdsField(node) {
  if (['INPUT', 'TEXTAREA', 'SELECT', 'IFRAME', 'FRAME', 'EMBED', 'OBJECT'].includes(node.nodeName)) {
    return true;
  }
  return [...(node.children ?? []), ...(node.shadowRoots ?? [])].some(holdsField);
}

/**
 * The boxes of elements whose closed shadow root holds a form field. The page's own DOM cannot reach
 * a closed root, so the browser's DOM view is asked instead, and the whole element is covered.
 */
async function closedShadowFieldBoxes(cdp) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const hosts = [];
  const visit = node => {
    for (const shadow of node.shadowRoots ?? []) {
      if (shadow.shadowRootType === 'closed' && holdsField(shadow)) {
        hosts.push(node.backendNodeId);
      }
      visit(shadow);
    }
    // A frame's own document is covered whole already; its tree is not walked here.
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(root);
  const boxes = [];
  for (const backendNodeId of hosts) {
    const model = await cdp.send('DOM.getBoxModel', { backendNodeId }).catch(() => undefined);
    if (model === undefined) {
      continue;
    }
    const xs = [0, 2, 4, 6].map(at => model.model.border[at]);
    const ys = [1, 3, 5, 7].map(at => model.model.border[at]);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    boxes.push({ left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top });
  }
  return boxes;
}

/** The bundled module, ending in one read of (and maybe one action on) the element at a snapshot id. */
function actScript(request) {
  return `(() => {\n${EXTRACT_MODULE}\nreturn actOnElement(${JSON.stringify(request)});\n})()`;
}

/**
 * The name of the script world the sidecar reads pages in. A page's scripts run in their own world
 * and can replace what the DOM's functions and properties return there; in this world they cannot,
 * so what the sidecar reads is what the browser holds.
 */
const READ_WORLD = 'aman-read';

/** Errors that mean the page moved on while it was read, so the read is tried again on the new page. */
const PAGE_MOVED_ERRORS = ['Execution context was destroyed', 'Cannot find context with specified id'];

/**
 * Input events the sidecar's own press or typing makes. While one is in progress, the read world
 * stops any of these that land outside the element it checked, before the page's own listeners see it.
 */
const GUARDED_EVENTS = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'auxclick',
  'dblclick',
  'contextmenu',
  'keydown',
  'keypress',
  'keyup',
  'beforeinput',
];

/**
 * Runs in the read world at the start of every document, before any of the page's scripts, so its
 * listener on the window comes first. While armed, a real input event whose target is not inside the
 * checked element is stopped and cancelled, and noted, so the action reports it as changed.
 */
const GUARD_SCRIPT = `(() => {
  const guard = { element: null, mode: null, strayed: false, landed: false, late: false };
  globalThis.amanGuard = guard;
  const check = event => {
    // Only real input is guarded: an event the page's own code makes follows from input that already
    // landed on the checked element.
    if (guard.element === null || !event.isTrusted) {
      return;
    }
    const target = event.composedPath()[0];
    if (target instanceof Node && guard.element.contains(target)) {
      guard.landed ||= event.type === 'pointerdown';
      return;
    }
    guard.strayed = true;
    event.stopImmediatePropagation();
    event.preventDefault();
  };
  for (const type of ${JSON.stringify(GUARDED_EVENTS)}) {
    window.addEventListener(type, check, true);
  }
})();`;

/**
 * Sets up the tab's read world: made again with the guard at the start of every document, and
 * tracked by its context id, so every read and action of one page uses the same world.
 */
async function prepareReadWorld(tab) {
  const { frameTree } = await tab.cdp.send('Page.getFrameTree');
  const mainFrameId = frameTree.frame.id;
  tab.cdp.on('Runtime.executionContextCreated', ({ context }) => {
    if (context.name === READ_WORLD && context.auxData?.frameId === mainFrameId) {
      tab.readWorld = context.id;
    }
  });
  tab.cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    if (executionContextId === tab.readWorld) {
      tab.readWorld = undefined;
    }
  });
  tab.cdp.on('Runtime.executionContextsCleared', () => {
    tab.readWorld = undefined;
  });
  await trackFrameWorlds({ session: tab.cdp, worlds: tab.frameWorlds, isTop: frameId => frameId === mainFrameId });
  // Scripts for new documents run only for a session with the Page domain on.
  await tab.cdp.send('Page.enable');
  await tab.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: GUARD_SCRIPT, worldName: READ_WORLD });
  tab.mainFrameId = mainFrameId;
}

/** Runs an expression in the tab's main frame, in the read world, which the page's own scripts cannot reach. */
async function inReadWorld({ tab, expression }) {
  if (tab.readWorld === undefined) {
    // The tab's first, empty document predates the guard script; it has no page scripts to stay ahead of.
    const { executionContextId } = await tab.cdp.send('Page.createIsolatedWorld', {
      frameId: tab.mainFrameId,
      worldName: READ_WORLD,
    });
    tab.readWorld = executionContextId;
    // The world is the one the guard script made at the start of the document, when there was one. A
    // guard set up now comes after the page's scripts, so it may not see input first: actions refuse it.
    await tab.cdp.send('Runtime.evaluate', {
      expression: `if (globalThis.amanGuard === undefined) {\n${GUARD_SCRIPT}\nglobalThis.amanGuard.late = true;\n}`,
      contextId: executionContextId,
    });
  }
  const reply = await tab.cdp.send('Runtime.evaluate', { expression, contextId: tab.readWorld, returnByValue: true });
  if (reply.exceptionDetails !== undefined) {
    throw new Error(`the page could not be read: ${reply.exceptionDetails.text}`);
  }
  return reply.result.value;
}

/**
 * Ends the guard of a press or of typing, and says whether its input went anywhere but the checked
 * element: some landed outside it, a press never reached it, or typing ended with the focus elsewhere.
 */
const DISARM_SCRIPT = `(() => {
  const guard = globalThis.amanGuard;
  let focused = document.activeElement;
  while (focused?.shadowRoot?.activeElement) {
    focused = focused.shadowRoot.activeElement;
  }
  const missed = guard.mode === 'press' ? !guard.landed : focused !== guard.element;
  const strayed = guard.strayed || missed;
  guard.element = null;
  guard.mode = null;
  guard.strayed = false;
  guard.landed = false;
  return strayed;
})()`;

/** True while the point a press is about to land on is still the checked element, and nothing has strayed. */
function stillOnElementScript({ x, y }) {
  return `(() => {
  const guard = globalThis.amanGuard;
  const hit = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
  return guard.element !== null && !guard.strayed && hit !== null && guard.element.contains(hit);
})()`;
}

/**
 * Sends the real input of an armed action. A press moves the pointer first and checks the point
 * again, since a page can move things when the pointer arrives: false, and nothing pressed, when it did.
 * Typing selects what is in the field with a real key press, so the keystrokes replace it. In a
 * multi-line field a line break or tab is inserted as text, so it never presses Enter or Tab.
 */
async function realInput({ tab, result, text }) {
  const { mouse, keyboard } = tab.page;
  if (result.status === 'press') {
    await mouse.move(result.x, result.y);
    if ((await inReadWorld({ tab, expression: stillOnElementScript(result) })) !== true) {
      return false;
    }
    await mouse.down();
    await mouse.up();
    return true;
  }
  if (result.clear) {
    await keyboard.press('ControlOrMeta+A');
    if (text === '') {
      await keyboard.press('Backspace');
    }
  }
  for (const part of result.multiline ? text.split(/(\r\n|\r|\n|\t)/) : [text]) {
    if (part === '\t') {
      await keyboard.insertText('\t');
    } else if (part === '\r\n' || part === '\r' || part === '\n') {
      await keyboard.insertText('\n');
    } else if (part !== '') {
      await keyboard.type(part);
    }
  }
  return true;
}

/** The binding a frame's guard calls when it stops input, so the action that sent it is refused. */
const FRAME_INPUT_BINDING = 'amanFrameInput';

/**
 * The name of each frame guard's switch, and the key it answers to. The key is made fresh for each run
 * of the sidecar. In the frame it is held only in the guard's closure, never in the text of a function
 * a script can reach, and the sidecar hands it over only through the browser's debugging channel,
 * never through any of the page's own JavaScript. So a frame's scripts can call the switch but never
 * turn their guard off.
 */
const FRAME_GUARD_SWITCH = 'amanFrameGuard';
const FRAME_GUARD_KEY = randomBytes(32).toString('hex');

/**
 * Runs before any script in every frame but the top one. Aman only ever acts on the top page, so any
 * real input that reaches a frame inside it (a frame the page slid under the pointer, or moved the
 * focus into) is stopped and cancelled before that frame's own code sees it, and reported. The guard
 * starts on; the sidecar switches it off only while the person's own live-view act runs, so they can
 * use a frame (a human check, a card form) by hand.
 */
const FRAME_GUARD_SCRIPT = `(() => {
  if (window === window.top) {
    return;
  }
  const apply = Reflect.apply;
  const stop = Event.prototype.stopImmediatePropagation;
  const cancel = Event.prototype.preventDefault;
  const report = window.${FRAME_INPUT_BINDING};
  const secret = ${JSON.stringify(FRAME_GUARD_KEY)};
  let on = true;
  Object.defineProperty(window, ${JSON.stringify(FRAME_GUARD_SWITCH)}, {
    value: (key, wanted) => {
      if (key !== secret) {
        return false;
      }
      on = wanted === true;
      return true;
    },
    writable: false,
    enumerable: false,
    configurable: false,
  });
  const block = event => {
    if (!on || !event.isTrusted) {
      return;
    }
    apply(stop, event, []);
    apply(cancel, event, []);
    if (typeof report === 'function') {
      apply(report, window, []);
    }
  };
  for (const type of ${JSON.stringify([...GUARDED_EVENTS, 'input'])}) {
    window.addEventListener(type, block, true);
  }
})();`;

const isStringRecord = value =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(entry => typeof entry === 'string');

/** An action's checked read as the app sent it, or null when it is missing or not that shape. */
export function parseElementReview(value) {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { site, accessible_name, role, is_form_submit, form_values, link_url } = value;
  if (
    typeof site !== 'string' ||
    typeof accessible_name !== 'string' ||
    typeof role !== 'string' ||
    typeof is_form_submit !== 'boolean' ||
    !isStringRecord(form_values) ||
    (link_url !== null && typeof link_url !== 'string')
  ) {
    return null;
  }
  return { site, accessible_name, role, is_form_submit, form_values, link_url };
}

/** How long the sidecar waits after an action for the page to start whatever the action set off. */
const SETTLE_MS = 500;

/** A URL's scheme, host without a leading `www.`, and port, or undefined for one with no host (about:blank, data:). */
function siteOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return {
      secure: parsed.protocol === 'https:',
      host: parsed.hostname.replace(/^www\./, ''),
      port: parsed.port,
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether `url` is on the site that was opened (`opened`, an address). A site's own `www.` name and a move
 * from http up to https count as the same site, since common sites redirect that way on every visit; a
 * move from https down to http, another host or another port does not.
 */
export function onSameSite({ url, opened }) {
  const target = siteOf(url);
  const site = opened === undefined ? undefined : siteOf(opened);
  if (target === undefined || site === undefined) {
    return false;
  }
  return target.host === site.host && target.port === site.port && (target.secure || !site.secure);
}

/** The most chats one person may have open at once; opening another closes the one used longest ago. */
export const MAX_TABS_PER_PERSON = 8;

/** How many times a read is tried while the page keeps moving to a new page of its site. */
const READ_ATTEMPTS = 3;

/** The answer for a chat with no tab: it never opened a page, or its tab closed to make room for others. */
const NO_TAB = { status: 'closed' };

/** Answered by the sidecar itself instead of the network: a browser does not navigate to No Content. */
const STAY_PUT = { status: 204 };

/**
 * One tab per chat. `opened` is the last address the model opened in this chat, which the app server
 * checked and classified. Content from any other site is never returned (see `#checkedPage`), and the
 * page cannot move its own tab to another site (see `guardNavigation` and `guardRedirects`): the
 * person's logins live in this profile, so a page that could send the tab to their mail would otherwise
 * get the mail read back. `goingBack` marks the one history step the model asked for.
 * `refusedRedirect` is where the last navigation tried to redirect to, off the opened site, and
 * `movedTo` is set when the model's own open was refused that way, until the next open.
 * `cdp` is the tab's DevTools session, which reads the page in a script world of its own (`readWorld`).
 */
function createTab({ page, cdp }) {
  return {
    page,
    cdp,
    mainFrameId: undefined,
    readWorld: undefined,
    refs: new RefAssigner(),
    opened: undefined,
    goingBack: false,
    refusedRedirect: undefined,
    movedTo: undefined,
    frameInput: false,
    // The page's own script world in each frame but the top one, by context id, with the frame's origin.
    frameWorlds: new Map(),
    // The frames from other sites, each with its own CDP session and its script worlds.
    remoteFrames: new Map(),
    // The page's last open file picker, waiting for the person to upload a file from the live view.
    fileChooser: undefined,
    // The live view's acts, run one at a time in the order they arrived, so typed keys never swap.
    liveActs: Promise.resolve(),
    // Whether the person has taken this tab over in the live view: while they have, the model's own
    // steps on the tab are refused, and the person's hand alone drives it.
    takeover: false,
    // Where the live view's pointer last was on the page, so a streamed move walks from there.
    pointer: undefined,
  };
}

/**
 * A picture of a tab's page. A headed window that has not drawn its first frame yet cannot be
 * captured, which is common right after a page opens, so that one error is tried again shortly.
 */
async function capturePage(page, options) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await page.screenshot(options);
    } catch (error) {
      if (attempt >= 3 || !String(error).includes('Unable to capture screenshot')) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

/**
 * Keeps the ids of the page's own script worlds in every frame but the top one that a CDP session
 * reaches, so a frame's guard can be switched there without going through any of the page's scripts.
 */
async function trackFrameWorlds({ session, worlds, isTop }) {
  session.on('Runtime.executionContextCreated', ({ context }) => {
    if (context.auxData?.isDefault === true && !isTop(context.auxData.frameId)) {
      worlds.set(context.id, context.origin);
    }
  });
  session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    worlds.delete(executionContextId);
  });
  session.on('Runtime.executionContextsCleared', () => {
    worlds.clear();
  });
  await session.send('Runtime.enable');
}

/** Errors that mean a frame's script world went away while it was being switched. */
const WORLD_GONE_ERRORS = ['Cannot find context with specified id', 'Execution context was destroyed', 'Target closed'];

/**
 * Turns the guard in every frame of the tab on or off, and says whether every frame still on the page
 * took it. A frame from another site runs in its own process, reached through a CDP session of its
 * own. A frame that goes away meanwhile is skipped: whatever loads in its place starts with its guard
 * on. A frame on the page's own origin that has no guard (an empty frame made before any script ran)
 * is the page's own, so it is not counted as a failure.
 */
async function setFrameGuards(tab, on) {
  for (const frame of tab.page.frames()) {
    if (frame === tab.page.mainFrame() || tab.remoteFrames.has(frame)) {
      continue;
    }
    // Only a frame from another site's process gets a session; any other frame is in the page's own.
    const session = await tab.page
      .context()
      .newCDPSession(frame)
      .catch(() => undefined);
    if (session !== undefined) {
      const worlds = new Map();
      tab.remoteFrames.set(frame, { session, worlds });
      await trackFrameWorlds({ session, worlds, isTop: () => false });
    }
  }
  for (const [frame, remote] of tab.remoteFrames) {
    if (frame.isDetached()) {
      tab.remoteFrames.delete(frame);
      await remote.session.detach().catch(() => undefined);
    }
  }
  const topOrigin = new URL(tab.page.url()).origin;
  const targets = [
    ...[...tab.frameWorlds].map(([id, origin]) => ({ session: tab.cdp, id, origin })),
    ...[...tab.remoteFrames.values()].flatMap(({ session, worlds }) =>
      [...worlds].map(([id, origin]) => ({ session, id, origin })),
    ),
  ];
  const results = await Promise.all(
    targets.map(async ({ session, id, origin }) => {
      try {
        const reply = await session.send('Runtime.evaluate', {
          expression: `window[${JSON.stringify(FRAME_GUARD_SWITCH)}]?.(${JSON.stringify(FRAME_GUARD_KEY)}, ${String(on)})`,
          contextId: id,
          returnByValue: true,
        });
        if (reply.exceptionDetails !== undefined) {
          return false;
        }
        return reply.result.value === true || (reply.result.value === undefined && origin === topOrigin);
      } catch (error) {
        return WORLD_GONE_ERRORS.some(message => String(error).includes(message));
      }
    }),
  );
  return results.every(Boolean);
}

/** Live-view acts that press or type; a move or a wheel turn is not input the frame guards stop. */
const GUARDED_LIVE_KINDS = new Set(['click', 'down', 'up', 'type', 'paste', 'key']);

/**
 * Runs the person's own live-view act with the frame guards off, so it reaches a frame they point at,
 * and turns them back on before anything else runs on the tab.
 */
async function livePersonAct(tab, input) {
  if (!GUARDED_LIVE_KINDS.has(input.kind)) {
    return liveAct(tab, input);
  }
  await setFrameGuards(tab, false);
  try {
    return await liveAct(tab, input);
  } finally {
    await setFrameGuards(tab, true);
  }
}

/**
 * Runs one act on the tab's real mouse or keyboard after every act sent before it has finished,
 * whether or not that one worked. The person's live-view acts and Aman's own checked input share
 * this one line, so the frame guards are never off while Aman's input runs.
 */
function inLiveOrder(tab, act) {
  const run = tab.liveActs.then(act);
  tab.liveActs = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * The steps a streamed pointer move is applied in: enough that no single step is a jump, so the
 * page sees a hand travelling, and never so many that the move lags behind the person's own.
 */
export function pointerSteps(distance) {
  return Math.min(50, Math.max(1, Math.round(distance / 10)));
}

/**
 * A point an act names, scaled from the frame it was read from to the page's viewport, so it lands
 * where the person touched the picture.
 */
function scaledPoint(page, input) {
  const viewport = page.viewportSize();
  const scale =
    viewport !== null && input.imageWidth !== undefined && input.imageHeight !== undefined
      ? { x: viewport.width / input.imageWidth, y: viewport.height / input.imageHeight }
      : { x: 1, y: 1 };
  return { x: input.x * scale.x, y: input.y * scale.y };
}

/** Walks the tab's pointer to a point in steps from where it last was, and remembers it there. */
async function movePointer(tab, point) {
  const last = tab.pointer;
  const distance = last === undefined ? 0 : Math.hypot(point.x - last.x, point.y - last.y);
  await tab.page.mouse.move(point.x, point.y, { steps: pointerSteps(distance) });
  tab.pointer = point;
}

/**
 * One pointer or keyboard act from the live view. A click keeps its one-step shape; the takeover
 * acts (move, down, up) are the person's own press, travelled to and let go where it happened.
 */
async function liveAct(tab, input) {
  const page = tab.page;
  switch (input.kind) {
    case 'click': {
      const point = scaledPoint(page, input);
      await page.mouse.click(point.x, point.y);
      tab.pointer = point;
      break;
    }
    case 'move':
      await movePointer(tab, scaledPoint(page, input));
      break;
    case 'down':
      await movePointer(tab, scaledPoint(page, input));
      await page.mouse.down();
      break;
    case 'up':
      await movePointer(tab, scaledPoint(page, input));
      await page.mouse.up();
      break;
    case 'type':
      await page.keyboard.type(input.text);
      break;
    case 'paste':
      // Pasted text goes in as one insert, the way a real paste does: a line break in it is text,
      // never a press of Enter that could send a half-filled form.
      await page.keyboard.insertText(input.text);
      break;
    case 'key':
      await page.keyboard.press(input.key);
      break;
    case 'wheel':
      await page.mouse.wheel(0, input.dy);
      break;
  }
  return { status: 'ok' };
}

/** The most text one copy out of the live view hands back: a code, an address or a few paragraphs. */
const MAX_LIVE_COPY_LENGTH = 100_000;

/**
 * What the person has selected in a frame: the selected part of the focused text field, or else the
 * page's own selection. A password field's text is never read out, as the page itself never lets it
 * be copied. Runs in the frame, so it must not name anything from this module.
 */
function selectedTextInFrame() {
  const { document, HTMLInputElement, HTMLTextAreaElement } = globalThis;
  let focused = document.activeElement;
  while (focused?.shadowRoot?.activeElement) {
    focused = focused.shadowRoot.activeElement;
  }
  const isField = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement;
  if (isField && focused.type === 'password') {
    return { focused: document.hasFocus(), password: true, text: '' };
  }
  if (isField && typeof focused.selectionStart === 'number' && typeof focused.selectionEnd === 'number') {
    const text = focused.value.slice(focused.selectionStart, focused.selectionEnd);
    if (text !== '') {
      return { focused: document.hasFocus(), password: false, text };
    }
  }
  return { focused: document.hasFocus(), password: false, text: String(globalThis.getSelection()?.toString() ?? '') };
}

/**
 * The text the person has selected in the tab, for the live view's copy. The frame that has focus
 * is asked first, so a selection in a sign-in frame wins over a leftover one in the page around it.
 */
async function selectedText(page) {
  const answers = [];
  for (const frame of page.frames()) {
    const answer = await frame.evaluate(selectedTextInFrame).catch(() => undefined);
    if (
      typeof answer === 'object' &&
      answer !== null &&
      typeof answer.text === 'string' &&
      typeof answer.focused === 'boolean' &&
      typeof answer.password === 'boolean'
    ) {
      answers.push(answer);
    }
  }
  const pick =
    answers.find(answer => answer.focused && (answer.password || answer.text !== '')) ??
    answers.find(answer => answer.text !== '');
  if (pick === undefined) {
    return { status: 'nothing_selected' };
  }
  if (pick.password) {
    return { status: 'password' };
  }
  return { status: 'ok', text: pick.text.slice(0, MAX_LIVE_COPY_LENGTH) };
}

/**
 * Fills the file picker the page opened, once. When there is none, or it can no longer take the
 * file (its field went away), the page's first file field gets it instead.
 */
async function putFile(tab, file) {
  const chooser = tab.fileChooser;
  tab.fileChooser = undefined;
  if (chooser !== undefined && !chooser.page().isClosed()) {
    const filled = await chooser.setFiles(file).then(
      () => true,
      () => false,
    );
    if (filled) {
      return { status: 'ok' };
    }
  }
  const field = tab.page.locator('input[type="file"]').first();
  if ((await field.count()) === 0) {
    return { status: 'no_file_field' };
  }
  await field.setInputFiles(file);
  return { status: 'ok' };
}

/** The host a human check's widget is served from, whichever site asked for the check. */
const CHALLENGE_HOST = 'challenges.cloudflare.com';

/** The title of the full-page check a site shows before its own page loads. */
const CHALLENGE_TITLE = 'Just a moment...';

/**
 * Whether the page is showing a human check: the check's own frame sits on the page, or the page
 * is the check itself. Only the frames' addresses and the title are read; nothing is changed.
 */
async function challengeShowing(page) {
  const title = await page.title().catch(() => '');
  if (title === CHALLENGE_TITLE) {
    return true;
  }
  return page.frames().some(frame => {
    try {
      return new URL(frame.url()).hostname === CHALLENGE_HOST;
    } catch {
      return false;
    }
  });
}

/**
 * Redirects of a tab's own page, checked as each response arrives and before the browser follows it:
 * the browser follows redirects without asking the route handler, so this is where a hop to another
 * site is refused. The page's body is never touched here; it streams to the browser as usual.
 */
async function guardRedirects({ tab, cdp }) {
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const mainFrameId = frameTree.frame.id;
  cdp.on('Fetch.requestPaused', event => {
    void (async () => {
      const status = event.responseStatusCode ?? 0;
      const location = (event.responseHeaders ?? []).find(header => header.name.toLowerCase() === 'location');
      if (event.frameId === mainFrameId && status >= 300 && status < 400 && location !== undefined) {
        const next = new URL(location.value, event.request.url).href;
        if (!onSameSite({ url: next, opened: tab.opened })) {
          tab.refusedRedirect = next;
          // The redirect's own headers must be replaced, or the browser still follows its Location.
          await cdp.send('Fetch.fulfillRequest', {
            requestId: event.requestId,
            responseCode: STAY_PUT.status,
            responseHeaders: [{ name: 'content-length', value: '0' }],
            body: '',
          });
          return;
        }
      }
      await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
    })().catch(() => undefined);
  });
  await cdp.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Response' }] });
}

/**
 * The route handler every request in a person's browser passes through. Top-level navigations of a
 * chat's tab may stay on the site that chat opened, and are refused when they would leave it. Pages
 * that are not a chat's tab (a popup) get nothing. Everything else continues to the egress proxy,
 * which checks where it goes.
 */
async function guardNavigation(profile, route) {
  const request = route.request();
  if (!request.isNavigationRequest()) {
    return route.continue();
  }
  let frame;
  try {
    frame = request.frame();
  } catch {
    return route.abort('blockedbyclient');
  }
  const tab = profile.tabsByPage.get(frame.page());
  if (tab === undefined) {
    return route.abort('blockedbyclient');
  }
  if (frame.parentFrame() !== null) {
    return route.continue();
  }
  if (tab.goingBack && request.method() === 'GET') {
    // History may hold another site; `#checkedPage` then reports it as moved instead of reading it.
    tab.goingBack = false;
    return route.continue();
  }
  if (onSameSite({ url: request.url(), opened: tab.opened })) {
    return route.continue();
  }
  return route.fulfill(STAY_PUT);
}

/**
 * The checks the egress gateway runs for an address, asked before the browser is touched so the model
 * gets a plain refusal. The gateway alone resolves names: the browser's network has no other way out.
 */
async function askGateway({ proxyServer, url }) {
  const response = await fetch(`${proxyServer}/check?url=${encodeURIComponent(url)}`);
  const body = await response.json();
  if (body?.ok === true && typeof body.url === 'string') {
    return { ok: true, url: new URL(body.url) };
  }
  return { ok: false, reason: typeof body?.reason === 'string' ? body.reason : 'unresolved' };
}

export class BrowserSidecar {
  #profiles = new Map();
  #profilesDir;
  #navTimeoutMs;
  #launch;
  #proxyServer;

  /**
   * `proxyServer` is the egress gateway every browser request goes through; it is required, so the
   * browser never talks to the network directly.
   */
  constructor({ profilesDir, navTimeoutMs, proxyServer, launch = launchPersistentChromium }) {
    if (typeof proxyServer !== 'string' || proxyServer === '') {
      throw new Error('the browser needs its egress proxy (BROWSER_PROXY)');
    }
    this.#profilesDir = profilesDir;
    this.#navTimeoutMs = navTimeoutMs;
    this.#launch = launch;
    this.#proxyServer = proxyServer;
  }

  /** One browser per person, launched once even when two requests for them arrive together. */
  profileFor(owner) {
    const existing = this.#profiles.get(owner);
    if (existing !== undefined) {
      return existing;
    }
    const starting = this.#startProfile(owner);
    this.#profiles.set(owner, starting);
    starting.catch(() => this.#profiles.delete(owner));
    return starting;
  }

  async #startProfile(owner) {
    const { context, page } = await this.#launch({
      userDataDir: path.join(this.#profilesDir, ownerDirName(owner)),
      proxyServer: this.#proxyServer,
    });
    const profile = {
      context,
      spare: page,
      tabs: new Map(),
      tabsByPage: new Map(),
      opening: Promise.resolve(),
    };
    // A page may not open windows of its own. Tabs are opened only inside `opening`, so a page that
    // is still not a tab once that settles is a popup: it is closed, and its requests are refused.
    context.on('page', other => {
      void profile.opening.then(() => {
        if (!profile.tabsByPage.has(other)) {
          other.close().catch(() => undefined);
        }
      });
    });
    await context.route('**/*', route => guardNavigation(profile, route));
    return profile;
  }

  /**
   * The chat's tab, now its most recently used one. Only `browser_open` opens a tab, so a chat with no
   * page open never pushes out another chat's tab; the person's least recently used tab closes past the cap.
   */
  async #tabFor({ owner, tab: tabId, create }) {
    const profile = await this.profileFor(owner);
    const result = profile.opening.then(async () => {
      const existing = profile.tabs.get(tabId);
      if (existing !== undefined) {
        profile.tabs.delete(tabId);
        profile.tabs.set(tabId, existing);
        return existing;
      }
      if (!create) {
        return undefined;
      }
      const page = profile.spare ?? (await profile.context.newPage());
      profile.spare = undefined;
      // A download never opens in the browser; refusing it keeps the tab from navigating to a file.
      page.on('download', download => {
        download.cancel().catch(() => undefined);
      });
      const tab = createTab({ page, cdp: await profile.context.newCDPSession(page) });
      // A file picker never opens on the virtual screen; the live view fills it with the person's file.
      page.on('filechooser', chooser => {
        tab.fileChooser = chooser;
      });
      // A picker belongs to the page that opened it; once the page has moved on, its element is gone.
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) {
          tab.fileChooser = undefined;
        }
      });
      await guardRedirects({ tab, cdp: tab.cdp });
      await prepareReadWorld(tab);
      await page.exposeBinding(FRAME_INPUT_BINDING, () => {
        tab.frameInput = true;
      });
      await page.addInitScript(FRAME_GUARD_SCRIPT);
      profile.tabs.set(tabId, tab);
      profile.tabsByPage.set(page, tab);
      if (profile.tabs.size > MAX_TABS_PER_PERSON) {
        const [oldestId, oldest] = profile.tabs.entries().next().value;
        profile.tabs.delete(oldestId);
        profile.tabsByPage.delete(oldest.page);
        await oldest.page.close().catch(() => undefined);
      }
      return tab;
    });
    profile.opening = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * The chat's page, or where it went instead: when the tab is on a site other than the one the model
   * opened (history, or a redirect that was refused), nothing of it is returned. The model is told the
   * address, and opening it is a new `browser_open` that the app server classifies on its own.
   */
  #checkedPage(tab) {
    if (tab === undefined) {
      return { ok: false, result: NO_TAB };
    }
    if (tab.movedTo !== undefined) {
      return { ok: false, result: { status: 'moved', url: tab.movedTo } };
    }
    const url = tab.page.url();
    if (url === 'about:blank') {
      return { ok: true };
    }
    if (!onSameSite({ url, opened: tab.opened })) {
      return { ok: false, result: { status: 'moved', url } };
    }
    return { ok: true };
  }

  async open({ owner, tab: tabId, url }) {
    const target = await askGateway({ proxyServer: this.#proxyServer, url });
    if (!target.ok) {
      return { status: 'refused', reason: target.reason };
    }
    const tab = await this.#tabFor({ owner, tab: tabId, create: true });
    if (tab.takeover) {
      return { status: 'refused', reason: 'takeover' };
    }
    tab.opened = target.url.href;
    return this.#navigate({ tab, url: target.url.href });
  }

  /** Loads an address in the tab, on the site it has open, then reads it. */
  async #navigate({ tab, url, referer }) {
    tab.refs.reset();
    tab.refusedRedirect = undefined;
    tab.movedTo = undefined;
    try {
      await tab.page.goto(url, {
        timeout: this.#navTimeoutMs,
        waitUntil: 'domcontentloaded',
        ...(referer === undefined ? {} : { referer }),
      });
    } catch (error) {
      // A refused redirect leaves the navigation without a page, which is reported as the move below.
      if (tab.refusedRedirect === undefined) {
        throw error;
      }
    }
    if (tab.refusedRedirect !== undefined) {
      tab.movedTo = tab.refusedRedirect;
      tab.opened = undefined;
    }
    return this.#read(tab);
  }

  async read({ owner, tab: tabId }) {
    return this.#read(await this.#tabFor({ owner, tab: tabId, create: false }));
  }

  /**
   * Reads the tab's page. A page that is moving to another page of its site while it is read is read
   * again once the new page has loaded, and checked again first, since where it went may have changed.
   */
  async #read(tab) {
    for (let attempt = 1; ; attempt += 1) {
      const checked = this.#checkedPage(tab);
      if (!checked.ok) {
        return checked.result;
      }
      try {
        const nodes = await inReadWorld({ tab, expression: EXTRACT_SCRIPT });
        const refs = tab.refs.refsFor(nodes);
        const view = await inReadWorld({ tab, expression: VIEW_SCRIPT });
        const text = renderSnapshot({ title: await tab.page.title(), url: tab.page.url(), nodes, refs, view });
        return { status: 'ok', text };
      } catch (error) {
        if (attempt >= READ_ATTEMPTS || !PAGE_MOVED_ERRORS.some(message => String(error).includes(message))) {
          throw error;
        }
        await tab.page.waitForLoadState('domcontentloaded', { timeout: this.#navTimeoutMs }).catch(() => undefined);
      }
    }
  }

  async scroll({ owner, tab: tabId, direction }) {
    const tab = await this.#tabFor({ owner, tab: tabId, create: false });
    if (tab === undefined) {
      return NO_TAB;
    }
    if (tab.takeover) {
      return { status: 'refused', reason: 'takeover' };
    }
    // The wheel scrolls whatever is under the pointer, so it is turned over the middle of the view,
    // and the pointer goes back to the corner so nothing in the middle stays hovered for the read.
    const viewport = tab.page.viewportSize() ?? { width: 1280, height: 800 };
    await tab.page.mouse.move(viewport.width / 2, viewport.height / 2);
    await tab.page.mouse.wheel(0, direction === 'up' ? -800 : 800);
    await tab.page.mouse.move(0, 0);
    // The wheel only starts the scroll; reading before it ends would show where the page was.
    await scrollSettled(tab.page);
    return this.#read(tab);
  }

  async back({ owner, tab: tabId }) {
    const tab = await this.#tabFor({ owner, tab: tabId, create: false });
    if (tab === undefined) {
      return NO_TAB;
    }
    if (tab.takeover) {
      return { status: 'refused', reason: 'takeover' };
    }
    tab.refs.reset();
    tab.goingBack = true;
    try {
      await tab.page.goBack({ timeout: this.#navTimeoutMs, waitUntil: 'domcontentloaded' });
    } finally {
      tab.goingBack = false;
    }
    return this.#read(tab);
  }

  async screenshot({ owner, tab: tabId }) {
    const tab = await this.#tabFor({ owner, tab: tabId, create: false });
    const checked = this.#checkedPage(tab);
    if (!checked.ok) {
      return checked.result;
    }
    const seen = await this.#pictureLayout(tab).catch(() => undefined);
    const buffer = await capturePage(tab.page, { type: 'png' });
    const model = seen === undefined ? undefined : await this.#modelCopy({ tab, seen, buffer });
    return {
      status: 'ok',
      png_base64: buffer.toString('base64'),
      ...(model === undefined ? {} : { model_png_base64: model.png.toString('base64'), text: model.text }),
    };
  }

  /**
   * The page as the model's copy of a screenshot needs it: its text snapshot, each control's ref and
   * box, and every box to cover (hidden fields, frames, and closed shadow roots that hold a field).
   * The layout is read in an isolated world, and nothing on the page is changed.
   */
  async #pictureLayout(tab) {
    const nodes = await inReadWorld({ tab, expression: EXTRACT_SCRIPT });
    const refs = tab.refs.refsFor(nodes);
    const cdp = await tab.page.context().newCDPSession(tab.page);
    try {
      const executionContextId = await isolatedWorld(cdp);
      const layout = await inIsolatedWorld({
        cdp,
        executionContextId,
        expression: boxesInViewScript([...refs.keys()]),
      });
      const covered = await inIsolatedWorld({ cdp, executionContextId, expression: MASK_BOXES_SCRIPT });
      // Where the view is, read with the layout so the page text says where the picture was taken.
      const view = await inIsolatedWorld({ cdp, executionContextId, expression: VIEW_SCRIPT });
      const text = renderSnapshot({ title: await tab.page.title(), url: tab.page.url(), nodes, refs, view });
      const closed = await closedShadowFieldBoxes(cdp);
      const boxOf = new Map(layout.boxes.map(({ path, ...box }) => [path, box]));
      return {
        text,
        width: covered.width,
        controls: [...refs].flatMap(([path, ref]) => {
          const box = boxOf.get(path);
          return box === undefined ? [] : [{ ref, box }];
        }),
        masks: [...covered.boxes, ...closed],
      };
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }

  /**
   * The picture the model sees, with the text snapshot from the same moment: the person's picture
   * with every password, card or one-time-code field covered and each control boxed with its ref,
   * drawn here and never in the page. The page is looked at again after the shot; if a hidden
   * field appeared or moved in between, or anything fails, the model gets no picture at all.
   */
  async #modelCopy({ tab, seen, buffer }) {
    try {
      const after = await this.#pictureLayout(tab);
      if (JSON.stringify(after.masks) !== JSON.stringify(seen.masks) || after.width !== seen.width) {
        return undefined;
      }
      const png = await markInWorker({ png: buffer, scale: pngWidth(buffer) / seen.width, ...seen });
      return { png, text: seen.text };
    } catch {
      return undefined;
    }
  }

  /**
   * Reads, and for an action acts on, the element a ref names in the chat's tab, in one step in the
   * page (see `actOnElement` in extract.mjs). Answers why there is nothing to act on instead: no tab,
   * a page that moved to another site (see `#checkedPage`), an unknown ref, or one the page no longer
   * has. Only `open` creates a tab, so an action on a chat with no page open is closed. `settled`
   * resolves once any page the action set off has loaded, or after a short wait when there is none.
   */
  async #onElement({ owner, tab: tabId, ref, ...request }) {
    const tab = await this.#tabFor({ owner, tab: tabId, create: false });
    if (tab === undefined) {
      return { tab, result: NO_TAB };
    }
    const checked = this.#checkedPage(tab);
    if (!checked.ok) {
      return { tab, result: checked.result };
    }
    // While the person drives the tab in the live view, Aman only looks; its own steps wait for Hand back.
    if (request.action !== 'info' && tab.takeover) {
      return { tab, result: { status: 'refused', reason: 'takeover' } };
    }
    const path = tab.refs.resolve(ref);
    if (path === undefined) {
      return { tab, result: { status: 'refused', reason: 'unknown_ref' } };
    }
    const started = tab.page
      .waitForEvent('framenavigated', { predicate: frame => frame === tab.page.mainFrame(), timeout: SETTLE_MS })
      .then(
        () => true,
        () => false,
      );
    const result = await inReadWorld({ tab, expression: actScript({ path, ...request }) });
    const settled = started.then(async loading => {
      if (loading) {
        await tab.page.waitForLoadState('domcontentloaded', { timeout: this.#navTimeoutMs }).catch(() => undefined);
      }
    });
    return { tab, result, settled };
  }

  /** The read an action on a ref is checked against, without changing the page. */
  async elementInfo({ owner, tab: tabId, ref }) {
    const { result } = await this.#onElement({ owner, tab: tabId, ref, action: 'info' });
    return result.status === 'ok' ? { status: 'ok', ...result.review } : result;
  }

  /**
   * Acts on the element at a ref, then reads the page. `expect` is the read the action was checked
   * against (by `elementInfo`, before anything in the reply ran): the action goes ahead only while the
   * element at the ref still reads that way. An earlier action in the same reply may have changed the
   * page, and refs restart on every new page, so the same ref can name another element by now; that
   * action is refused as changed, and never lands on something nobody checked.
   */
  async #act({ owner, tab: tabId, ref, action, expect, ...rest }) {
    const expected = parseElementReview(expect);
    if (expected === null) {
      return { status: 'refused', reason: 'unchecked' };
    }
    const { tab, result, settled } = await this.#onElement({
      owner,
      tab: tabId,
      ref,
      action,
      expect: expected,
      ...rest,
    });
    if (result.status === 'navigate') {
      return onSameSite({ url: result.url, opened: tab.opened })
        ? this.#navigate({ tab, url: result.url, referer: tab.page.url() })
        : { status: 'moved', url: result.url };
    }
    if (result.status === 'press' || result.status === 'keys') {
      // Real input, so the page's controls react as they do to a person. The guards stop any of it
      // that lands outside the checked element, in this page or a frame inside it, before the page sees it.
      const sent = await inLiveOrder(tab, async () => {
        // Every live act turns the guards back on; this checks that each frame really took it.
        if (!(await setFrameGuards(tab, true))) {
          return 'unguarded';
        }
        tab.frameInput = false;
        return realInput({ tab, result, text: rest.text });
      }).then(
        done => ({ done }),
        error => ({ error }),
      );
      // A page that moved on took the guard with it; a fresh document has none armed.
      const strayed = await inReadWorld({ tab, expression: DISARM_SCRIPT }).catch(() => false);
      if (sent.error !== undefined) {
        throw sent.error;
      }
      // A frame on the page whose guard could not be checked could take this input unseen.
      if (sent.done === 'unguarded') {
        tab.refs.reset();
        return { status: 'refused', reason: 'unchecked' };
      }
      if (!sent.done || strayed === true || tab.frameInput) {
        tab.refs.reset();
        return { status: 'refused', reason: 'changed' };
      }
    } else if (result.status !== 'done') {
      return result;
    }
    await settled;
    tab.refs.reset();
    // A frame's report of stopped input can arrive just after the input itself.
    if (tab.frameInput) {
      return { status: 'refused', reason: 'changed' };
    }
    return this.#read(tab);
  }

  /** Clicks the element at a ref. A plain link is not pressed: its address is opened, so no script of the page runs. */
  async click({ owner, tab: tabId, ref, expect }) {
    return this.#act({ owner, tab: tabId, ref, action: 'click', expect });
  }

  /** Types into a field; refuses a password, card or one-time-code field, and a disabled or read-only one. */
  async type({ owner, tab: tabId, ref, expect, text }) {
    if (typeof text !== 'string') {
      return { status: 'refused', reason: 'unchecked' };
    }
    return this.#act({ owner, tab: tabId, ref, action: 'type', expect, text });
  }

  /** Picks an option on a `<select>`, by its value or its visible label. */
  async select({ owner, tab: tabId, ref, expect, option }) {
    return this.#act({ owner, tab: tabId, ref, action: 'select', expect, option });
  }

  /**
   * The person's open tabs for the live view, most recently used first. Listing never launches a
   * browser: a person who has not opened anything has no tabs to show.
   */
  async liveTabs({ owner }) {
    const starting = this.#profiles.get(owner);
    if (starting === undefined) {
      return { status: 'ok', tabs: [] };
    }
    const profile = await starting.catch(() => undefined);
    if (profile === undefined) {
      return { status: 'ok', tabs: [] };
    }
    const tabs = [];
    for (const [tabId, tab] of [...profile.tabs.entries()].reverse()) {
      tabs.push({ tab: tabId, title: await tab.page.title().catch(() => ''), url: tab.page.url() });
    }
    return { status: 'ok', tabs };
  }

  /**
   * One frame of the chat's tab for the live view. The live view is the person's own look at their
   * own browser, so unlike `#read` it is not held to the opened site: the tab itself still cannot
   * leave that site (see `guardNavigation`), and only the app server may ask, for the signed-in
   * person's own profile.
   */
  async liveFrame({ owner, tab: tabId }) {
    const tab = await this.#tabFor({ owner, tab: tabId, create: false });
    if (tab === undefined) {
      return NO_TAB;
    }
    const buffer = await capturePage(tab.page, { type: 'jpeg', quality: 60 });
    const viewport = tab.page.viewportSize();
    return {
      status: 'ok',
      jpeg_base64: buffer.toString('base64'),
      ...(viewport === null ? {} : { width: viewport.width, height: viewport.height }),
      // Whose hand is on the tab, and whether the page is asking for a human check: the view says
      // both plainly instead of leaving the person to guess at either.
      takeover: tab.takeover,
      challenge: await challengeShowing(tab.page),
    };
  }

  /**
   * Hands the tab to the person, or back to the model. The tab never leaves the browser: only whose
   * hand drives it changes, so what the person finishes stays in the page for the next read. While
   * the tab is taken over, the model's own steps on it are refused (see `open` and the rest).
   */
  async liveTakeover({ owner, tab: tabId, on }) {
    const tab = await this.#tabFor({ owner, tab: tabId, create: false });
    if (tab === undefined) {
      return NO_TAB;
    }
    tab.takeover = on;
    return { status: 'ok', takeover: tab.takeover };
  }

  /**
   * One pointer or keyboard act in the chat's tab, from the live view. Clicks go through the real
   * mouse, so a click that would take the page off the opened site is refused by the same route
   * guard as every other navigation.
   */
  async liveInput({ owner, tab: tabId, input }) {
    const tab = await this.#tabFor({ owner, tab: tabId, create: false });
    if (tab === undefined) {
      return NO_TAB;
    }
    return inLiveOrder(tab, () => livePersonAct(tab, input));
  }

  /**
   * The text the person selected in the chat's tab, for the live view's copy. It goes back only to
   * the person's own live view; it is never kept, logged or shown to the model.
   */
  async liveCopy({ owner, tab: tabId }) {
    const tab = await this.#tabFor({ owner, tab: tabId, create: false });
    if (tab === undefined) {
      return NO_TAB;
    }
    return inLiveOrder(tab, () => selectedText(tab.page));
  }

  /**
   * Puts a file the person chose in the live view into the page: into the file picker the page just
   * opened, or else the page's first file field. Nothing is uploaded until the page itself sends it.
   */
  async liveUpload({ owner, tab: tabId, name, mime, data }) {
    const tab = await this.#tabFor({ owner, tab: tabId, create: false });
    if (tab === undefined) {
      return NO_TAB;
    }
    const file = { name, mimeType: mime, buffer: Buffer.from(data, 'base64') };
    if (file.buffer.length > MAX_UPLOAD_BYTES) {
      return { status: 'bad_input' };
    }
    return inLiveOrder(tab, () => putFile(tab, file));
  }

  async close() {
    for (const starting of this.#profiles.values()) {
      const profile = await starting.catch(() => undefined);
      await profile?.context.close();
    }
    this.#profiles.clear();
  }
}

/** Environment variables Chromium may see; nothing else of this process's environment reaches it. */
const BROWSER_ENV_KEYS = ['DISPLAY', 'XAUTHORITY', 'HOME', 'PATH', 'LANG', 'TZ', 'XDG_RUNTIME_DIR', 'FONTCONFIG_PATH'];

export function browserEnv(env = process.env) {
  return Object.fromEntries(BROWSER_ENV_KEYS.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
}

/**
 * Launches Chromium headed (there is no `headless` option here on purpose), with its own persistent
 * profile, its sandbox on, every request sent through the egress proxy (loopback included: an empty
 * bypass list keeps Chromium from talking to anything directly), and service workers off so no
 * request escapes the route handler.
 */
export async function launchPersistentChromium({ userDataDir, proxyServer, executablePath }) {
  // Chromium's profile lock names the host it ran on, and a recreated container has a new host name, so
  // a lock left by the last container would refuse the profile for good. This sidecar owns the volume
  // and launches each profile once (see `sessionFor`), so a lock found here is always a stale one.
  await Promise.all(
    ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].map(name =>
      rm(path.join(userDataDir, name), { force: true }),
    ),
  );
  const context = await chromium.launchPersistentContext(userDataDir, {
    // Only for running the tests against a Chromium that is installed elsewhere; the image uses its own.
    ...(executablePath === undefined ? {} : { executablePath }),
    headless: false,
    chromiumSandbox: true,
    env: browserEnv(),
    proxy: { server: proxyServer, bypass: '' },
    serviceWorkers: 'block',
    acceptDownloads: false,
    viewport: { width: 1280, height: 800 },
    // WebRTC may not open its own UDP paths around the proxy.
    args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

/** The profile folder name for one person: a short hash, never the raw id, in case it is ever logged. */
function ownerDirName(owner) {
  return createHash('sha256').update(owner).digest('hex').slice(0, 32);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  const limit = req.url === '/live/upload' ? MAX_UPLOAD_BODY_BYTES : MAX_BODY_BYTES;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new Error('request body too large');
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : JSON.parse(text);
}

/** The most text one live-view input may type at once: a pasted code or a short form answer, not a document. */
const MAX_LIVE_TEXT_LENGTH = 10000;

const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);

/**
 * The point a pointer act names, with the frame size the point was read from (when the caller
 * measured one), or undefined when the point is not a point.
 */
function parsePoint(body) {
  if (!isFiniteNumber(body.x) || !isFiniteNumber(body.y)) {
    return undefined;
  }
  const imageWidth = isFiniteNumber(body.image_width) && body.image_width > 0 ? body.image_width : undefined;
  const imageHeight = isFiniteNumber(body.image_height) && body.image_height > 0 ? body.image_height : undefined;
  return {
    x: body.x,
    y: body.y,
    ...(imageWidth === undefined ? {} : { imageWidth }),
    ...(imageHeight === undefined ? {} : { imageHeight }),
  };
}

/**
 * A live-view input from the request body, or undefined when it is not one the page can be given:
 * a pointer act with its point (a click, or the takeover acts move, down and up), typed or pasted
 * text, one named key, or a scroll step.
 */
function parseLiveInput(body) {
  switch (body.kind) {
    case 'click':
    case 'move':
    case 'down':
    case 'up': {
      const point = parsePoint(body);
      return point === undefined ? undefined : { kind: body.kind, ...point };
    }
    case 'type':
    case 'paste':
      return typeof body.text === 'string' && body.text !== '' && body.text.length <= MAX_LIVE_TEXT_LENGTH
        ? { kind: body.kind, text: body.text }
        : undefined;
    case 'key':
      return typeof body.key === 'string' && body.key !== '' && body.key.length <= 64
        ? { kind: 'key', key: body.key }
        : undefined;
    case 'wheel':
      return isFiniteNumber(body.dy) ? { kind: 'wheel', dy: body.dy } : undefined;
    default:
      return undefined;
  }
}

const ROUTES = {
  'POST /open': (sidecar, where, body) => sidecar.open({ ...where, url: body.url }),
  'POST /read': (sidecar, where) => sidecar.read(where),
  'POST /scroll': (sidecar, where, body) => sidecar.scroll({ ...where, direction: body.direction }),
  'POST /back': (sidecar, where) => sidecar.back(where),
  'POST /screenshot': (sidecar, where) => sidecar.screenshot(where),
  'POST /element-info': (sidecar, where, body) => sidecar.elementInfo({ ...where, ref: body.ref }),
  'POST /click': (sidecar, where, body) => sidecar.click({ ...where, ref: body.ref, expect: body.expect }),
  'POST /type': (sidecar, where, body) =>
    sidecar.type({ ...where, ref: body.ref, expect: body.expect, text: body.text }),
  'POST /select': (sidecar, where, body) =>
    sidecar.select({ ...where, ref: body.ref, expect: body.expect, option: body.option }),
  'POST /live/frame': (sidecar, where) => sidecar.liveFrame(where),
  'POST /live/tabs': (sidecar, where) => sidecar.liveTabs(where),
  'POST /live/upload': (sidecar, where, body) =>
    typeof body.name === 'string' &&
    body.name !== '' &&
    body.name.length <= 255 &&
    typeof body.mime === 'string' &&
    body.mime.length <= 255 &&
    typeof body.data === 'string'
      ? sidecar.liveUpload({ ...where, name: body.name, mime: body.mime, data: body.data })
      : { status: 'bad_input' },
  'POST /live/input': (sidecar, where, body) => {
    const input = parseLiveInput(body);
    return input === undefined ? { status: 'bad_input' } : sidecar.liveInput({ ...where, input });
  },
  'POST /live/copy': (sidecar, where) => sidecar.liveCopy(where),
  'POST /live/takeover': (sidecar, where, body) =>
    typeof body.on === 'boolean' ? sidecar.liveTakeover({ ...where, on: body.on }) : { status: 'bad_input' },
};

const MAX_ID_LENGTH = 256;
const isId = value => typeof value === 'string' && value !== '' && value.length <= MAX_ID_LENGTH;

/** A peer address as the gateway's lookup spells it: an IPv4 client reached over a dual-stack socket loses its prefix. */
function plainAddress(address) {
  return typeof address === 'string' && address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

/**
 * `allowedPeers` returns the addresses calls may come from: the gateway's, which has checked the app
 * server's secret. Chromium runs in this container, so a call from anywhere in it (loopback, or this
 * container's own address) is refused.
 */
export function createHttpServer({ sidecar, allowedPeers }) {
  if (typeof allowedPeers !== 'function') {
    throw new Error('the browser API needs the gateway it answers (BROWSER_API_PEER)');
  }
  return createServer((req, res) => {
    void (async () => {
      let peers;
      try {
        peers = await allowedPeers();
      } catch {
        peers = [];
      }
      if (!peers.map(plainAddress).includes(plainAddress(req.socket.remoteAddress))) {
        res.writeHead(403).end(JSON.stringify({ status: 'error', message: 'calls come through the gateway only' }));
        return;
      }
      await handleRequest({ req, res, sidecar });
    })();
  });
}

/** Draws the model's copy in a worker of its own (see pictureWorker.mjs) and answers it as a PNG. */
function markInWorker({ png, scale, controls, masks }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pictureWorker.mjs', import.meta.url), {
      workerData: { png, scale, controls, masks },
    });
    // Drawing is bounded work; a worker that has not answered by now is stopped, and no copy is made.
    const timer = setTimeout(() => {
      reject(new Error('the picture worker took too long'));
      void worker.terminate();
    }, PICTURE_WORKER_MS);
    worker.once('message', marked => {
      clearTimeout(timer);
      resolve(Buffer.from(marked));
      void worker.terminate();
    });
    worker.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error('the picture worker stopped'));
      }
    });
  });
}

/** The width a PNG says it is, from its header. */
function pngWidth(png) {
  return png.readUInt32BE(16);
}

/**
 * A fixed reason for a step that failed, never the error's own text: that text can come from the
 * page (a script error it threw), so it must not reach the model as the browser's words.
 */
export function failureReason(error) {
  const message = error instanceof Error ? error.message : '';
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'timeout';
  }
  if (/net::ERR_|NS_ERROR_|Navigation failed/.test(message)) {
    return 'navigation_failed';
  }
  if (/not attached|detached|Target page, context or browser has been closed|Target closed/i.test(message)) {
    return 'page_changed';
  }
  if (/^(page|frame|locator)\.evaluate:/.test(message) || /Execution context was destroyed/.test(message)) {
    return 'page_script_error';
  }
  return 'unknown';
}

async function handleRequest({ req, res, sidecar }) {
  const route = ROUTES[`${req.method} ${req.url}`];
  if (route === undefined) {
    res.writeHead(404).end(JSON.stringify({ status: 'error', message: 'no such route' }));
    return;
  }
  try {
    const body = await readJsonBody(req);
    // `owner` picks the person's browser profile; `tab` picks the chat's tab inside it. Listing the
    // tabs is the one call that names no tab: the list is how the tabs are found in the first place.
    if (!isId(body.owner) || (req.url !== '/live/tabs' && !isId(body.tab))) {
      res.writeHead(400).end(JSON.stringify({ status: 'error', message: 'owner and tab are required' }));
      return;
    }
    const result = await route(sidecar, { owner: body.owner, tab: body.tab }, body);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  } catch (error) {
    // The full message stays in the sidecar's own log; the caller gets only the fixed reason.
    process.stderr.write(
      `browser sidecar: ${req.url} failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    res
      .writeHead(500, { 'content-type': 'application/json' })
      .end(JSON.stringify({ status: 'error', reason: failureReason(error) }));
  }
}
