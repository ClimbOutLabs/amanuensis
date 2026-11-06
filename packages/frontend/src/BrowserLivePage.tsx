/**
 * Aman's browser, live: the signed-in person watches one of their own browser tabs and drives it
 * by hand, for the steps only a person can do (finishing a sign-in, a code sent to their phone, a
 * cookie banner). A frame is asked for about twice a second; clicks, typing and scrolls go back to
 * the same tab. Every call goes to the app server with the person's own session: the browser's
 * secret never reaches this page.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
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

/** One call to the live routes; answers with the route's `data`, and throws when the call itself failed. */
async function liveCall(path: string, body?: Record<string, unknown>): Promise<unknown> {
  const response = await liveFetch(apiPath(path), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`live call failed: ${String(response.status)}`);
  }
  const json: unknown = await response.json();
  return isRecord(json) && 'data' in json ? json.data : json;
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

export function BrowserLivePage() {
  const [tabs, setTabs] = useState<LiveTab[]>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [frame, setFrame] = useState<string | undefined>(undefined);
  const [note, setNote] = useState('Loading your tabs...');
  const [done, setDone] = useState(false);
  const [typeText, setTypeText] = useState('');
  const imgRef = useRef<HTMLImageElement | null>(null);
  const lastWheelAtRef = useRef(0);

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
    if (selected === undefined || done) {
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
          setNote('');
        } else if (isRecord(data) && data.status === 'closed') {
          setFrame(undefined);
          setNote('That page is closed now. Pick another tab, or ask Aman to open the page again.');
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
  }, [selected, done]);

  const sendInput = useCallback(
    async (input: Record<string, unknown>) => {
      if (selected === undefined) {
        return;
      }
      try {
        await liveCall('/api/browser/live/input', { tab: selected, ...input });
      } catch {
        // The next frame shows what the page looks like now, whether the act landed or not.
      }
    },
    [selected],
  );

  const onFrameClick = (event: ReactMouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (img === null || img.naturalWidth === 0 || img.naturalHeight === 0) {
      return;
    }
    // The picture inside its border: a click on the border's edge maps to the frame's own edge.
    const rect = img.getBoundingClientRect();
    const left = rect.left + img.clientLeft;
    const top = rect.top + img.clientTop;
    // clientWidth rounds to whole pixels; the drawn size, less both borders, does not.
    const width = rect.width - (img.offsetWidth - img.clientWidth);
    const height = rect.height - (img.offsetHeight - img.clientHeight);
    if (width === 0 || height === 0) {
      return;
    }
    const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
    void sendInput({
      kind: 'click',
      x: clamp(Math.round(((event.clientX - left) / width) * img.naturalWidth), img.naturalWidth),
      y: clamp(Math.round(((event.clientY - top) / height) * img.naturalHeight), img.naturalHeight),
      image_width: img.naturalWidth,
      image_height: img.naturalHeight,
    });
  };

  const onFrameWheel = (event: ReactWheelEvent) => {
    const now = Date.now();
    if (now - lastWheelAtRef.current < 150) {
      return;
    }
    lastWheelAtRef.current = now;
    void sendInput({ kind: 'wheel', dy: Math.round(event.deltaY) });
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      void sendInput({ kind: 'type', text: event.key });
    } else if (NAMED_KEYS.has(event.key)) {
      event.preventDefault();
      void sendInput({ kind: 'key', key: event.key });
    }
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
        .catch(() => {
          setNote("The file could not be put in the page. Click the page's upload button first, then try again.");
        });
    };
    reader.readAsDataURL(file);
  };

  const onTypeSubmit = () => {
    if (typeText === '') {
      return;
    }
    void sendInput({ kind: 'type', text: typeText });
    setTypeText('');
  };

  if (done) {
    return (
      <main className="browser-live">
        <div className="browser-live-body">
          <h1 className="browser-live-title">Aman&apos;s browser, live</h1>
          <p className="browser-live-note">
            Done. Aman has the tab back, with everything you did still in it. You can close this page.
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
          When you are done, press Done and Aman carries on from here.
        </p>
        <div className="browser-live-row" role="group" aria-label="Open tabs">
          {tabs.map(tab => (
            <button
              key={tab.tab}
              type="button"
              className="browser-live-button"
              aria-pressed={tab.tab === selected}
              onClick={() => {
                setSelected(tab.tab);
                setFrame(undefined);
              }}
            >
              {tab.title === '' ? tab.url : tab.title}
            </button>
          ))}
          <button type="button" className="browser-live-button" onClick={refreshTabs}>
            Refresh tabs
          </button>
        </div>
        {note !== '' ? (
          <p className="browser-live-note" role="status">
            {note}
          </p>
        ) : null}
        {frame !== undefined ? (
          <div className="browser-live-frame" tabIndex={0} onKeyDown={onKeyDown} onWheel={onFrameWheel}>
            <img
              ref={imgRef}
              src={`data:image/jpeg;base64,${frame}`}
              alt="The page Aman has open, as it looks now"
              onClick={onFrameClick}
            />
          </div>
        ) : null}
        <p className="browser-live-hint">
          Click the picture, then type to fill in a field. Scrolling over the picture scrolls the page.
        </p>
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
