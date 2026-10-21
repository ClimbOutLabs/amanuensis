'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { Button } from '../atoms/primitives/Button.js';
import { Icon } from '../icons/Icon.js';
import type {
  ChatImageOutcome,
  ChatImagesCatalog,
  ChatImageSource,
  TurnImageList,
  TurnImagesResult,
} from '../plugins/trueforge-agent-server-adapter/catalogs/chatImagesCatalog.js';
import { useChatImageScope, type ChatImageScopeValue } from './chatImageScope.js';
import { CHAT_IMAGE_ERROR_TEXT, CHAT_IMAGE_REFUSAL_TEXT } from './refusalText.js';

type ShowState =
  | { kind: 'loading' }
  | { kind: 'ask'; count: number; host: string | null }
  | { kind: 'done'; images: ChatImageOutcome[] }
  | { kind: 'error' };

/**
 * One request per turn and source, shared by every component that shows it, so re-renders while a
 * reply streams or a remount never ask the server twice.
 */
const pending = new Map<string, Promise<TurnImagesResult>>();

function requestKey(input: {
  scope: Pick<ChatImageScopeValue, 'sessionId' | 'turnId'>;
  source: ChatImageSource;
  approved: boolean;
}): string {
  return JSON.stringify([input.scope.sessionId, input.scope.turnId, input.source, input.approved]);
}

function showOnce(input: {
  scope: Pick<ChatImageScopeValue, 'port' | 'sessionId' | 'turnId'>;
  source: ChatImageSource;
  approved: boolean;
}) {
  const key = requestKey(input);
  let request = pending.get(key);
  if (request === undefined) {
    request = input.scope.port.showTurnImages({
      sessionId: input.scope.sessionId,
      turnId: input.scope.turnId,
      source: input.source,
      approved: input.approved,
    });
    // Once approved, a remounted card shows the images instead of asking again.
    const keys = input.approved ? [key, requestKey({ ...input, approved: false })] : [key];
    for (const each of keys) {
      pending.set(each, request);
    }
    // A failed request may be retried on the next render.
    request.catch(() => {
      for (const each of keys) {
        pending.delete(each);
      }
    });
  }
  return request;
}

function toState(result: TurnImagesResult): ShowState {
  return result.status === 'ask'
    ? { kind: 'ask', count: result.count, host: result.host }
    : { kind: 'done', images: result.images };
}

/** `source` must keep its identity across renders (callers build it with useMemo). */
function useShowImages(input: { scope: ChatImageScopeValue | null; source: ChatImageSource; enabled: boolean }) {
  const { scope, source, enabled } = input;
  const [state, setState] = useState<ShowState>({ kind: 'loading' });

  useEffect(() => {
    if (scope === null || !enabled) {
      return;
    }
    let live = true;
    showOnce({ scope, source, approved: false }).then(
      result => live && setState(toState(result)),
      () => live && setState({ kind: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [scope, source, enabled]);

  const approve = useCallback(() => {
    if (scope === null) {
      return;
    }
    setState({ kind: 'loading' });
    showOnce({ scope, source, approved: true }).then(
      result => setState(toState(result)),
      () => setState({ kind: 'error' }),
    );
  }, [scope, source]);

  return { state, approve };
}

function Notice({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <span
      className="my-1 inline-flex max-w-full items-start gap-2 rounded border border-border bg-card-bg px-2 py-1 text-xs text-text-secondary"
      data-testid={testId}
    >
      <Icon name="image" className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

/** Stands in for an image chat will not render, such as an inline image the model wrote into its reply. */
export function ChatImageNotShown({ alt }: { alt: string }) {
  return (
    <Notice testId="aui-chat-image-not-shown">{alt === '' ? 'Image not shown.' : `${alt} (image not shown)`}</Notice>
  );
}

/** A plain line that keeps pictures hidden until the person chooses to see them. */
function HiddenImages({
  label,
  action,
  testId,
  onShow,
}: {
  label: string;
  action: string;
  testId: string;
  onShow: () => void;
}) {
  return (
    <span className="my-1 flex flex-wrap items-center gap-2 text-sm text-text-secondary" data-testid={testId}>
      <span>{label}</span>
      <Button variant="secondary" size="small" onClick={onShow}>
        {action}
      </Button>
    </span>
  );
}

/**
 * The re-encoded copy of a sent attachment, found by its turn and position. Undefined while the
 * sandbox works on it or when it cannot be shown; the chip then shows the file name instead.
 */
export function useUploadImageSrc(input: {
  port: ChatImagesCatalog | null;
  sessionId: string | undefined;
  turnId: string | undefined;
  index: number | undefined;
}): string | undefined {
  const { port, sessionId, turnId, index } = input;
  const [src, setSrc] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (port === null || sessionId === undefined || turnId === undefined || index === undefined) {
      return;
    }
    let live = true;
    showOnce({ scope: { port, sessionId, turnId }, source: { kind: 'upload', index }, approved: false }).then(
      result => {
        const first = result.status === 'done' ? result.images[0] : undefined;
        if (live && first?.status === 'shown') {
          setSrc(port.imageUrl({ sessionId, imageId: first.image_id }));
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [port, sessionId, turnId, index]);
  return src;
}

/**
 * A re-encoded image from this chat's own image route, as a 10rem thumbnail that opens the full image
 * in a new tab. A picture the browser cannot load leaves nothing behind, not even an empty box.
 */
export function SafeImage({ src, alt, width, height }: { src: string; alt: string; width: number; height: number }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return null;
  }
  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className="my-2 inline-block max-w-full rounded"
      data-testid="aui-chat-image-link"
    >
      <img
        src={src}
        alt={alt}
        width={width}
        height={height}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="aui-chat-image block h-auto w-40 max-w-full rounded border border-border object-contain"
        data-testid="aui-chat-image"
      />
    </a>
  );
}

function Outcome({ outcome, alt, scope }: { outcome: ChatImageOutcome; alt: string; scope: ChatImageScopeValue }) {
  if (outcome.status === 'refused') {
    return <Notice testId="aui-chat-image-refused">{CHAT_IMAGE_REFUSAL_TEXT[outcome.reason]}</Notice>;
  }
  return (
    <SafeImage
      src={scope.port.imageUrl({ sessionId: scope.sessionId, imageId: outcome.image_id })}
      alt={alt}
      width={outcome.width}
      height={outcome.height}
    />
  );
}

/** A stored sandbox image such as a chart: shown after the sandbox re-encodes it, never asks. */
export function ArtifactChatImage({ path, alt }: { path: string; alt: string }) {
  const source = useMemo<ChatImageSource>(() => ({ kind: 'artifact', path }), [path]);
  const scope = useChatImageScope();
  const { state } = useShowImages({ scope, source, enabled: true });
  if (scope === null) {
    return null;
  }
  switch (state.kind) {
    case 'loading':
    case 'ask':
      return <Notice testId="aui-chat-image-loading">Preparing image…</Notice>;
    case 'error':
      return <Notice testId="aui-chat-image-error">{CHAT_IMAGE_ERROR_TEXT}</Notice>;
    case 'done':
      return (
        <>
          {state.images.map((outcome, index) => (
            <Outcome key={index} outcome={outcome} alt={alt} scope={scope} />
          ))}
        </>
      );
  }
}

/**
 * An image link in a reply. Hidden until the person asks, so a web picture never appears on its own.
 * The link itself is never handed to the browser as an image address.
 */
export function ReplyChatImage({ url, alt }: { url: string; alt: string }) {
  const scope = useChatImageScope();
  const settled = scope?.settled ?? false;
  const source = useMemo<ChatImageSource>(() => ({ kind: 'reply', url }), [url]);
  const { state, approve } = useShowImages({ scope, source, enabled: settled });
  if (scope === null || !settled || state.kind === 'loading') {
    return <Notice testId="aui-chat-image-loading">{alt === '' ? 'Image' : alt}</Notice>;
  }
  switch (state.kind) {
    case 'ask':
      return (
        <HiddenImages
          label={`Image from ${state.host ?? 'the web'} hidden`}
          action="Show image"
          testId="aui-chat-image-hidden"
          onShow={approve}
        />
      );
    case 'error':
      // A link the server does not find in the reply (for example inside a tool result) is not shown.
      return <ChatImageNotShown alt={alt} />;
    case 'done':
      return (
        <>
          {state.images.map((outcome, index) => (
            <Outcome key={index} outcome={outcome} alt={alt} scope={scope} />
          ))}
        </>
      );
  }
}

/** One line per email message: its linked images stay hidden until the person chooses Show images. */
export function EmailImagesCard({ toolCallId, count }: { toolCallId: string; count: number }) {
  const scope = useChatImageScope();
  const source = useMemo<ChatImageSource>(() => ({ kind: 'email', tool_call_id: toolCallId }), [toolCallId]);
  const { state, approve } = useShowImages({ scope, source, enabled: true });
  if (scope === null) {
    return null;
  }
  const single = count === 1;
  switch (state.kind) {
    case 'loading':
      return <Notice testId="aui-email-images-loading">Loading images…</Notice>;
    case 'ask':
      return (
        <HiddenImages
          label={single ? 'Image hidden' : 'Images hidden'}
          action={single ? 'Show image' : 'Show images'}
          testId="aui-email-images-hidden"
          onShow={approve}
        />
      );
    case 'error':
      return <Notice testId="aui-chat-image-error">{CHAT_IMAGE_ERROR_TEXT}</Notice>;
    case 'done':
      return (
        <span className="flex flex-wrap gap-2 empty:hidden" data-testid="aui-email-images">
          {state.images.map((outcome, index) => (
            <Outcome key={index} outcome={outcome} alt={`Image ${String(index + 1)} from the email`} scope={scope} />
          ))}
        </span>
      );
  }
}

/** Images a tool returned stay hidden until the person asks to see them. */
function ToolImagesCard({ images }: { images: TurnImageList['tool_images'] }) {
  const [shown, setShown] = useState(false);
  if (!shown) {
    const single = images.length === 1;
    return (
      <HiddenImages
        label={single ? 'Image hidden' : 'Images hidden'}
        action={single ? 'Show image' : 'Show images'}
        testId="aui-tool-images-hidden"
        onShow={() => setShown(true)}
      />
    );
  }
  return (
    <div className="flex flex-wrap gap-2 empty:hidden" data-testid="aui-tool-images">
      {images.map(image => (
        <ArtifactChatImage key={image.path} path={image.path} alt={image.name} />
      ))}
    </div>
  );
}

/** Images a turn produced outside its text: sandbox images, images a tool returned, and a line per email that links images. */
export function TurnImages() {
  const scope = useChatImageScope();
  const [list, setList] = useState<TurnImageList | null>(null);

  useEffect(() => {
    if (scope === null || !scope.settled) {
      return;
    }
    let live = true;
    scope.port.listTurnImages({ sessionId: scope.sessionId, turnId: scope.turnId }).then(
      result => live && setList(result),
      () => live && setList(null),
    );
    return () => {
      live = false;
    };
  }, [scope]);

  if (list === null || (list.artifacts.length === 0 && list.tool_images.length === 0 && list.emails.length === 0)) {
    return null;
  }
  return (
    <div className="aui-turn-images mt-2 flex flex-col gap-2 empty:hidden" data-testid="aui-turn-images">
      {list.emails.map(email => (
        <EmailImagesCard key={email.tool_call_id} toolCallId={email.tool_call_id} count={email.count} />
      ))}
      {list.artifacts.length > 0 && (
        <div className="flex flex-wrap gap-2 empty:hidden">
          {list.artifacts.map(artifact => (
            <ArtifactChatImage key={artifact.path} path={artifact.path} alt={artifact.name} />
          ))}
        </div>
      )}
      {list.tool_images.length > 0 && <ToolImagesCard images={list.tool_images} />}
    </div>
  );
}
