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

export function BrowserLivePage() {
  const [tabs, setTabs] = useState<LiveTab[]>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [frame, setFrame] = useState<string | undefined>(undefined);
  const [note, setNote] = useState('Loading your tabs...');
  const [done, setDone] = useState(false);
  const [typeText, setTypeText] = useState('');
  const imgRef = useRef<HTMLImageElement | null>(null);
  const lastWheelAt = useRef(0);

  const refreshTabs = useCallback(async () => {
    try {
      const data = await liveCall('/api/browser/live/tabs');
      const list = isRecord(data) && Array.isArray(data.tabs) ? data.tabs.filter(isLiveTab) : [];
      setTabs(list);
      setSelected(current => (current !== undefined && list.some(tab => tab.tab === current) ? current : list[0]?.tab));
      if (list.length === 0) {
        setNote('Aman has no page open right now. Ask Aman to open the page first, then come back here.');
      }
    } catch {
      setNote('The live view could not be reached. Try again in a moment.');
    }
  }, []);

  useEffect(() => {
    void refreshTabs();
  }, [refreshTabs]);

  useEffect(() => {
    if (selected === undefined || done) {
      return;
    }
    let cancelled = false;
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
        window.setTimeout(() => {
          void tick();
        }, 500);
      }
    };
    void tick();
    return () => {
      cancelled = true;
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
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }
    void sendInput({
      kind: 'click',
      x: Math.round(((event.clientX - rect.left) / rect.width) * img.naturalWidth),
      y: Math.round(((event.clientY - rect.top) / rect.height) * img.naturalHeight),
      image_width: img.naturalWidth,
      image_height: img.naturalHeight,
    });
  };

  const onFrameWheel = (event: ReactWheelEvent) => {
    const now = Date.now();
    if (now - lastWheelAt.current < 150) {
      return;
    }
    lastWheelAt.current = now;
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

  const onTypeSubmit = () => {
    if (typeText === '') {
      return;
    }
    void sendInput({ kind: 'type', text: typeText });
    setTypeText('');
  };

  if (done) {
    return (
      <div style={{ maxWidth: '60rem', margin: '0 auto', padding: '1rem' }}>
        <h1>Aman&apos;s browser, live</h1>
        <p>Done. Aman has the tab back, with everything you did still in it. You can close this page.</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '60rem', margin: '0 auto', padding: '1rem' }}>
      <h1>Aman&apos;s browser, live</h1>
      <p>
        This is the page Aman has open. Click, scroll and type to use it yourself, for example to finish a sign-in.
        When you are done, press Done and Aman carries on from here.
      </p>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        {tabs.map(tab => (
          <button
            key={tab.tab}
            type="button"
            onClick={() => {
              setSelected(tab.tab);
              setFrame(undefined);
            }}
            style={{ fontWeight: tab.tab === selected ? 'bold' : 'normal' }}
          >
            {tab.title === '' ? tab.url : tab.title}
          </button>
        ))}
        <button type="button" onClick={() => void refreshTabs()}>
          Refresh tabs
        </button>
      </div>
      {note !== '' ? <p>{note}</p> : null}
      {frame !== undefined ? (
        <div
          tabIndex={0}
          onKeyDown={onKeyDown}
          onWheel={onFrameWheel}
          style={{ outline: '0.125rem solid transparent' }}
        >
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${frame}`}
            alt="The page Aman has open, as it looks now"
            onClick={onFrameClick}
            style={{ width: '100%', border: '0.0625rem solid #888', cursor: 'pointer', display: 'block' }}
          />
        </div>
      ) : null}
      <p style={{ fontSize: '0.8125rem' }}>
        Click the picture, then type to fill in a field. Scrolling over the picture scrolls the page.
      </p>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <input
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
          style={{ flex: 1 }}
        />
        <button type="button" onClick={onTypeSubmit}>
          Type it
        </button>
      </div>
      <button type="button" onClick={() => setDone(true)}>
        Done
      </button>
    </div>
  );
}
