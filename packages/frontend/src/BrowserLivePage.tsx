/**
 * Aman's browser, live: the signed-in person watches one of their own browser tabs and drives it
 * by hand, for the steps only a person can do (finishing a sign-in, a code sent to their phone, a
 * cookie banner). A frame is asked for about twice a second; clicks, typing, pastes and scrolls go
 * back to the same tab, and text selected in the tab can be copied out. Every call goes to the app
 * server with the person's own session: the browser's secret never reaches this page.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { createAuthAwareFetch } from './authFetch';
import './BrowserLivePage.css';
import { apiPath } from './publicPath';

interface LiveTab {
  tab: string;
  title: string;
  url: string;
}

const liveFetch = createAuthAwareFetch();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLiveTab(value: unknown): value is LiveTab {
  return (
    isRecord(value) && typeof value.tab === 'string' && typeof value.title === 'string' && typeof value.url === 'string'
  );
}

/** The route's own plain message for a failed call, when it sent one. */
function errorMessageOf(json: unknown): string | undefined {
  return isRecord(json) && isRecord(json.error) && typeof json.error.message === 'string' && json.error.message !== ''
    ? json.error.message
    : undefined;
}

/**
 * One call to the live routes; answers with the route's `data`. A failed call throws with the
 * route's own message, so the person reads why (a closed tab, a file too big) and what to do.
 * A keepalive call is finished by the browser even while the page itself is going away.
 */
async function liveCall(
  path: string,
  body?: Record<string, unknown>,
  options?: { keepalive?: boolean },
): Promise<unknown> {
  const response = await liveFetch(apiPath(path), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(options?.keepalive === true ? { keepalive: true } : {}),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(errorMessageOf(json) ?? 'The live view could not be reached. Try again in a moment.');
  }
  return isRecord(json) && 'data' in json ? json.data : json;
}

/** Whether this browser tab is in view; frames are only worth asking for while it is. */
function useTabVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const onChange = () => {
      setVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', onChange);
    return () => {
      document.removeEventListener('visibilitychange', onChange);
    };
  }, []);
  return visible;
}

/** Keys that are sent as one named press rather than typed text. */
const NAMED_KEYS = new Set([
  'Enter',
  'Backspace',
  'Tab',
  'Escape',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/** The most text one paste may put in the page, as the app server takes it. */
const MAX_PASTE_LENGTH = 10000;

/**
 * Puts text on the person's own clipboard. The text is still on its way from the tab when the
 * copy starts, so where the browser can, the clipboard is handed the coming text at once, while the
 * person's key press or click still counts; otherwise it is written once the text is here.
 */
async function writeClipboard(text: Promise<string>): Promise<void> {
  // Every path below reads the text's failure itself; this keeps an early return from leaving it unread.
  text.catch(() => undefined);
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard === undefined) {
    throw new Error('Copying needs Aman opened over a secure link (one that starts with https).');
  }
  if (typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
    const blob = text.then(value => new Blob([value], { type: 'text/plain' }));
    try {
      await clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return;
    } catch (error) {
      // A copy whose text failed to arrive carries the route's own reason; anything else falls through.
      const reason = await text.then(
        () => undefined,
        (failure: unknown) => failure,
      );
      if (reason !== undefined) {
        throw reason instanceof Error
          ? reason
          : new Error('The text could not be copied. Try again.', { cause: error });
      }
    }
  }
  await clipboard.writeText(await text);
}

/** The person's open tabs, or null when the live routes could not be reached. */
async function loadTabs(): Promise<LiveTab[] | null> {
  try {
    const data = await liveCall('/api/browser/live/tabs');
    return isRecord(data) && Array.isArray(data.tabs) ? data.tabs.filter(isLiveTab) : [];
  } catch {
    return null;
  }
}

/** How often a new frame is asked for while a tab is shown. */
const FRAME_INTERVAL_MS = 500;

/** How often a pointer move is sent while the person is driving under takeover; the rest are dropped. */
const MOVE_THROTTLE_MS = 50;

export function BrowserLivePage() {
  const [tabs, setTabs] = useState<LiveTab[]>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [frame, setFrame] = useState<string | undefined>(undefined);
  const [note, setNote] = useState('Loading your tabs...');
  // Whether the shown tab answered closed; kept apart from `note` so a new frame never wipes an upload's answer.
  const [closed, setClosed] = useState(false);
  const [done, setDone] = useState(false);
  const [typeText, setTypeText] = useState('');
  // What the person's password manager filled in, held only until it is put in the page.
  const [signInName, setSignInName] = useState('');
  const [signInPassword, setSignInPassword] = useState('');
  // Whose hand is on the shown tab, and whether it is asking for a human check; both read from the
  // frame answers, so this page shows the browser's own state rather than its guess at it.
  const [takeover, setTakeover] = useState(false);
  const [challenge, setChallenge] = useState(false);
  // Bumped to look at a tab again after it answered closed; picking a tab or refreshing does it.
  const [frameRun, setFrameRun] = useState(0);
  const visible = useTabVisible();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const lastWheelAtRef = useRef(0);
  // Whether the person's pointer is down on the picture, and when its last move was sent.
  const pressingRef = useRef(false);
  const lastMoveAtRef = useRef(0);
  // Every act waits for the one before it, so keys typed fast reach the page in the order typed.
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve());
  // The shown tab and whose hand is on it, in refs, so the leaving handlers below can hand the tab
  // back even at moments when no new frame will arrive to say whose hand it is in.
  const selectedRef = useRef<string | undefined>(undefined);
  const takeoverRef = useRef(false);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    takeoverRef.current = takeover;
  }, [takeover]);

  const applyTabs = useCallback((list: LiveTab[] | null) => {
    if (list === null) {
      setNote('The live view could not be reached. Try again in a moment.');
      return;
    }
    setTabs(list);
    setSelected(current => (current !== undefined && list.some(tab => tab.tab === current) ? current : list[0]?.tab));
    setNote(
      list.length === 0 ? 'Aman has no page open right now. Ask Aman to open the page first, then come back here.' : '',
    );
  }, []);

  const refreshTabs = useCallback(() => {
    setFrameRun(run => run + 1);
    void loadTabs().then(applyTabs);
  }, [applyTabs]);

  useEffect(() => {
    let cancelled = false;
    void loadTabs().then(list => {
      if (!cancelled) {
        applyTabs(list);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [applyTabs]);

  useEffect(() => {
    if (selected === undefined || done || !visible) {
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const data = await liveCall('/api/browser/live/frame', { tab: selected });
        if (cancelled) {
          return;
        }
        if (isRecord(data) && data.status === 'ok' && typeof data.jpeg_base64 === 'string') {
          setFrame(data.jpeg_base64);
          setClosed(false);
          if (typeof data.takeover === 'boolean') {
            setTakeover(data.takeover);
          }
          setChallenge(data.challenge === true);
        } else if (isRecord(data) && data.status === 'closed') {
          // A closed tab stays closed until the person picks a tab or refreshes, so stop asking.
          setFrame(undefined);
          setClosed(true);
          return;
        }
      } catch {
        // A missed frame keeps the last one; the next try is half a second away.
      }
      if (!cancelled) {
        timer = window.setTimeout(() => {
          void tick();
        }, FRAME_INTERVAL_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selected, done, visible, frameRun]);

  const sendInput = useCallback(
    (input: Record<string, unknown>) => {
      if (selected === undefined) {
        return;
      }
      inputQueueRef.current = inputQueueRef.current.then(async () => {
        try {
          await liveCall('/api/browser/live/input', { tab: selected, ...input });
        } catch {
          // The next frame shows what the page looks like now, whether the act landed or not.
        }
      });
    },
    [selected],
  );

  /**
   * Where a press on the picture falls in the frame it shows, in frame pixels and with the frame's
   * size, or undefined while the picture is not ready to be pressed.
   */
  const framePoint = (event: { clientX: number; clientY: number }) => {
    const img = imgRef.current;
    if (img === null || img.naturalWidth === 0 || img.naturalHeight === 0) {
      return undefined;
    }
    // The picture inside its border: a click on the border's edge maps to the frame's own edge.
    const rect = img.getBoundingClientRect();
    const left = rect.left + img.clientLeft;
    const top = rect.top + img.clientTop;
    // clientWidth rounds to whole pixels; the drawn size, less both borders, does not.
    const width = rect.width - (img.offsetWidth - img.clientWidth);
    const height = rect.height - (img.offsetHeight - img.clientHeight);
    if (width === 0 || height === 0) {
      return undefined;
    }
    const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
    return {
      x: clamp(Math.round(((event.clientX - left) / width) * img.naturalWidth), img.naturalWidth),
      y: clamp(Math.round(((event.clientY - top) / height) * img.naturalHeight), img.naturalHeight),
      image_width: img.naturalWidth,
      image_height: img.naturalHeight,
    };
  };

  const onFrameClick = (event: ReactMouseEvent<HTMLImageElement>) => {
    // Under takeover the press and release go as their own acts; a click act on top would double them.
    if (takeover) {
      return;
    }
    const point = framePoint(event);
    if (point !== undefined) {
      sendInput({ kind: 'click', ...point });
    }
  };

  const onFramePointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (!takeover) {
      return;
    }
    const point = framePoint(event);
    if (point === undefined) {
      return;
    }
    event.preventDefault();
    pressingRef.current = true;
    lastMoveAtRef.current = 0;
    try {
      // Holding the pointer keeps the stream coming even when the hand strays off the picture.
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Without capture the press still streams while the pointer stays over the picture.
    }
    sendInput({ kind: 'down', ...point });
  };

  const onFramePointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    // Under takeover the hand's whole path is the point, pressed or not: the approach is streamed
    // too, throttled, so the page is driven the way the person actually moves over the picture.
    if (!takeover) {
      return;
    }
    const now = Date.now();
    if (now - lastMoveAtRef.current < MOVE_THROTTLE_MS) {
      return;
    }
    const point = framePoint(event);
    if (point === undefined) {
      return;
    }
    lastMoveAtRef.current = now;
    sendInput({ kind: 'move', ...point });
  };

  const onFramePointerUp = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (!takeover || !pressingRef.current) {
      return;
    }
    pressingRef.current = false;
    const point = framePoint(event);
    if (point !== undefined) {
      sendInput({ kind: 'up', ...point });
    }
  };

  const onFrameWheel = (event: ReactWheelEvent) => {
    const now = Date.now();
    if (now - lastWheelAtRef.current < 150) {
      return;
    }
    lastWheelAtRef.current = now;
    sendInput({ kind: 'wheel', dy: Math.round(event.deltaY) });
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    // Select all goes to the page, so a field's text can be selected there and then copied out.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      sendInput({ kind: 'key', key: 'ControlOrMeta+A' });
      return;
    }
    // AltGr reports Ctrl and Alt together on Windows, and is how @, € and { are typed on many layouts.
    const altGraph = event.getModifierState('AltGraph');
    if (event.metaKey || ((event.ctrlKey || event.altKey) && !altGraph)) {
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      sendInput({ kind: 'type', text: event.key });
    } else if (NAMED_KEYS.has(event.key)) {
      event.preventDefault();
      sendInput({ kind: 'key', key: event.key });
    }
  };

  /** Puts the person's text in the page as one paste. It is never kept here or shown anywhere. */
  const pasteText = (text: string) => {
    if (text === '') {
      return;
    }
    if (text.length > MAX_PASTE_LENGTH) {
      setNote('That is too much text to paste at once. Paste up to 10,000 characters.');
      return;
    }
    sendInput({ kind: 'paste', text });
  };

  const onFramePaste = (event: ReactClipboardEvent) => {
    event.preventDefault();
    pasteText(event.clipboardData.getData('text/plain'));
  };

  /** Copies what is selected in the page to the person's own clipboard. */
  const copyFromPage = () => {
    if (selected === undefined) {
      return;
    }
    const tab = selected;
    // The copy waits its turn behind any keys still on their way, such as a select all.
    const text = inputQueueRef.current.then(async () => {
      const data = await liveCall('/api/browser/live/copy', { tab });
      if (!isRecord(data) || typeof data.text !== 'string') {
        throw new Error('The text could not be copied. Try again.');
      }
      return data.text;
    });
    writeClipboard(text)
      .then(() => {
        setNote('Copied. You can paste it anywhere on your computer now.');
      })
      .catch((error: unknown) => {
        setNote(error instanceof Error ? error.message : 'The text could not be copied. Try again.');
      });
  };

  const onFrameCopy = (event: ReactClipboardEvent) => {
    event.preventDefault();
    copyFromPage();
  };

  /** Pastes from the person's clipboard by button, for a phone or a browser with no paste key. */
  const onPasteButton = () => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined || typeof clipboard.readText !== 'function') {
      setNote('Click the picture, then press Ctrl+V (Cmd+V on a Mac) to paste.');
      return;
    }
    clipboard
      .readText()
      .then(text => {
        if (text === '') {
          setNote('Your clipboard has no text to paste.');
          return;
        }
        pasteText(text);
      })
      .catch(() => {
        setNote(
          'Your browser did not let Aman read the clipboard. Click the picture, then press Ctrl+V (Cmd+V on a Mac).',
        );
      });
  };

  const onUpload = (file: File | undefined) => {
    if (file === undefined || selected === undefined) {
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setNote('That file is too big. Files up to 10 MB work.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const data = result.slice(result.indexOf(',') + 1);
      setNote(`Sending ${file.name}...`);
      liveCall('/api/browser/live/upload', { tab: selected, name: file.name, mime: file.type, data })
        .then(() => {
          setNote(`${file.name} is in the page. Press the page's own upload or send button to finish.`);
        })
        .catch((error: unknown) => {
          setNote(
            error instanceof Error
              ? error.message
              : "The file could not be put in the page. Click the page's upload button first, then try again.",
          );
        });
    };
    reader.readAsDataURL(file);
  };

  const onTypeSubmit = () => {
    if (typeText === '') {
      return;
    }
    sendInput({ kind: 'type', text: typeText });
    setTypeText('');
  };

  const onSignInNameSubmit = () => {
    pasteText(signInName);
    setSignInName('');
  };

  const onSignInPasswordSubmit = () => {
    pasteText(signInPassword);
    setSignInPassword('');
  };

  /** Hands the shown tab to the person, or back to Aman; the answer says which hand holds it now. */
  const onTakeoverToggle = () => {
    if (selected === undefined) {
      return;
    }
    liveCall('/api/browser/live/takeover', { tab: selected, on: !takeover })
      .then(data => {
        if (isRecord(data) && typeof data.takeover === 'boolean') {
          setTakeover(data.takeover);
        }
      })
      .catch((error: unknown) => {
        setNote(error instanceof Error ? error.message : 'Takeover could not be changed. Try again in a moment.');
      });
  };

  /**
   * Hands the shown tab back to Aman when the person leaves it without pressing Hand back, so a
   * tab is never left in the person's hand after they have gone: Aman would refuse every step on
   * it and the person would not know why. The ref is cleared first, so the leaving paths below
   * send the hand back once between them.
   */
  const handBackOnLeave = useCallback((options?: { keepalive?: boolean }) => {
    const tab = selectedRef.current;
    if (tab === undefined || !takeoverRef.current) {
      return;
    }
    takeoverRef.current = false;
    void liveCall('/api/browser/live/takeover', { tab, on: false }, options).catch(() => {
      // The person is leaving either way; a failed hand back leaves the tab as it was.
    });
  }, []);

  // The page going away (pagehide), or this page closing inside the app (unmount), hands a
  // taken-over tab back. Both send with keepalive, as the page may not wait for the answer.
  useEffect(() => {
    const onPageHide = () => {
      handBackOnLeave({ keepalive: true });
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      handBackOnLeave({ keepalive: true });
    };
  }, [handBackOnLeave]);

  // Frames are only asked for while this page is in view. When it goes out of view, the person has
  // turned away from the tab, most often to the chat, so a taken-over tab is handed back too.
  useEffect(() => {
    if (!visible) {
      handBackOnLeave();
    }
  }, [visible, handBackOnLeave]);

  if (done) {
    return (
      <main className="browser-live">
        <div className="browser-live-body">
          <h1 className="browser-live-title">Aman&apos;s browser, live</h1>
          <p className="browser-live-note">
            Done. Go back to the chat and tell Aman you are finished. Everything you did stays in the page.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="browser-live">
      <div className="browser-live-body">
        <h1 className="browser-live-title">Aman&apos;s browser, live</h1>
        <p className="browser-live-text">
          This is the page Aman has open. Click, scroll and type to use it yourself, for example to finish a sign-in.
          When you are done, press Done, then go back to the chat and tell Aman.
        </p>
        <div className="browser-live-row" role="group" aria-label="Open tabs">
          {tabs.map(tab => (
            <button
              key={tab.tab}
              type="button"
              className="browser-live-button"
              aria-pressed={tab.tab === selected}
              onClick={() => {
                // Leaving a taken-over tab for another one hands it back first.
                if (tab.tab !== selected) {
                  handBackOnLeave();
                }
                setSelected(tab.tab);
                setFrame(undefined);
                // The new tab's own state arrives with its first frame.
                setTakeover(false);
                setChallenge(false);
                pressingRef.current = false;
                setFrameRun(run => run + 1);
              }}
            >
              {tab.title === '' ? tab.url : tab.title}
            </button>
          ))}
          <button type="button" className="browser-live-button" onClick={refreshTabs}>
            Refresh tabs
          </button>
        </div>
        {closed ? (
          <p className="browser-live-note" role="status">
            That page is closed now. Pick another tab, or ask Aman to open the page again.
          </p>
        ) : null}
        {note !== '' ? (
          <p className="browser-live-note" role="status">
            {note}
          </p>
        ) : null}
        {selected !== undefined && !closed ? (
          <div className="browser-live-row">
            <button type="button" className="browser-live-button" aria-pressed={takeover} onClick={onTakeoverToggle}>
              {takeover ? 'Hand back' : 'Take over'}
            </button>
            {takeover ? (
              <span className="browser-live-text">You are driving this page. Aman will not touch it.</span>
            ) : null}
          </div>
        ) : null}
        {takeover && challenge ? (
          <p className="browser-live-note" role="status">
            This site is asking for a human check. Takeover gives you your best chance at it.
          </p>
        ) : null}
        {frame !== undefined ? (
          <div
            className={takeover ? 'browser-live-frame browser-live-frame-takeover' : 'browser-live-frame'}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onPaste={onFramePaste}
            onCopy={onFrameCopy}
            onWheel={onFrameWheel}
          >
            <img
              ref={imgRef}
              src={`data:image/jpeg;base64,${frame}`}
              alt="The page Aman has open, as it looks now"
              draggable={takeover ? false : undefined}
              onClick={onFrameClick}
              onPointerDown={onFramePointerDown}
              onPointerMove={onFramePointerMove}
              onPointerUp={onFramePointerUp}
              onPointerCancel={onFramePointerUp}
            />
          </div>
        ) : null}
        <p className="browser-live-hint">
          {takeover
            ? 'Move and press on the picture to use the page, just as your hand does. Typing still works after you press the picture.'
            : 'Click the picture, then type to fill in a field. Scrolling over the picture scrolls the page.'}{' '}
          Paste into the page with Ctrl+V (Cmd+V on a Mac). To copy, select text in the page, then press Ctrl+C (Cmd+C).
        </p>
        <div className="browser-live-row">
          <button
            type="button"
            className="browser-live-button"
            onClick={onPasteButton}
            disabled={selected === undefined}
          >
            Paste into page
          </button>
          <button
            type="button"
            className="browser-live-button"
            onClick={copyFromPage}
            disabled={selected === undefined}
          >
            Copy from page
          </button>
        </div>
        <div className="browser-live-row">
          <input
            className="browser-live-input"
            aria-label="Text to type into the page"
            value={typeText}
            onChange={event => {
              setTypeText(event.target.value);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                onTypeSubmit();
              }
            }}
            placeholder="Text or a code to type into the page"
          />
          <button type="button" className="browser-live-button" onClick={onTypeSubmit}>
            Type it
          </button>
        </div>
        {/* These boxes sit on Aman's own address, so they ask the password manager not to offer or save
            Aman's own sign-in here: the person picks the outside site's login by hand. */}
        <form
          className="browser-live-sign-in"
          aria-label="Sign in with your password manager"
          onSubmit={event => {
            // Nothing is sent anywhere by the form itself; each box has its own button.
            event.preventDefault();
          }}
        >
          <p className="browser-live-text">
            Sign in with your password manager: click the site&apos;s name or password box in the picture, fill the
            matching box below from your password manager, then press its Put in page button. Nothing you put here is
            saved or shown to Aman.
          </p>
          <div className="browser-live-row">
            <input
              className="browser-live-input"
              aria-label="Name or email for the page"
              name="page-name"
              autoComplete="off"
              value={signInName}
              onChange={event => {
                setSignInName(event.target.value);
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onSignInNameSubmit();
                }
              }}
              placeholder="Name or email"
            />
            <button type="button" className="browser-live-button" onClick={onSignInNameSubmit}>
              Put name in page
            </button>
          </div>
          <div className="browser-live-row">
            <input
              className="browser-live-input"
              aria-label="Password for the page"
              type="password"
              name="page-password"
              autoComplete="off"
              value={signInPassword}
              onChange={event => {
                setSignInPassword(event.target.value);
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onSignInPasswordSubmit();
                }
              }}
              placeholder="Password"
            />
            <button type="button" className="browser-live-button" onClick={onSignInPasswordSubmit}>
              Put password in page
            </button>
          </div>
        </form>
        <label className="browser-live-text">
          Upload a file into the page:{' '}
          <input
            type="file"
            onChange={event => {
              onUpload(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </label>
        <div className="browser-live-row">
          <button
            type="button"
            className="browser-live-button browser-live-button-primary"
            onClick={() => {
              // Done leaves the live view, so a tab still in the person's hand is handed back.
              handBackOnLeave();
              setDone(true);
            }}
          >
            Done
          </button>
        </div>
      </div>
    </main>
  );
}
