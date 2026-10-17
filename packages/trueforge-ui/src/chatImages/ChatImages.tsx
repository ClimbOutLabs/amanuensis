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
  | { kind: 'declined' }
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

  const decline = useCallback(() => setState({ kind: 'declined' }), []);
  return { state, approve, decline };
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

/** A re-encoded image from this chat's own image route. `alt` is plain text from the reply or file name. */
export function SafeImage({ src, alt, width, height }: { src: string; alt: string; width: number; height: number }) {
  return (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="aui-chat-image my-2 h-auto max-h-[24rem] w-auto max-w-full rounded border border-border object-contain"
      data-testid="aui-chat-image"
    />
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

function AskCard(input: {
  question: string;
  detail: string;
  showLabel: string;
  onShow: () => void;
  onDecline: () => void;
  testId: string;
}) {
  return (
    <span
      className="my-2 flex max-w-[32rem] flex-col gap-2 rounded-lg border border-border bg-primary-bg px-3 py-2"
      data-testid={input.testId}
      role="group"
      aria-label={input.question}
    >
      <span className="text-sm font-medium text-text-primary">{input.question}</span>
      <span className="text-sm text-text-secondary">{input.detail}</span>
      <span className="flex flex-wrap gap-2">
        <Button variant="primary" size="large" onClick={input.onShow}>
          {input.showLabel}
        </Button>
        <Button variant="secondary" size="large" onClick={input.onDecline}>
          Not now
        </Button>
      </span>
    </span>
  );
}

/** A stored sandbox or tool image: shown after the sandbox re-encodes it, never asks. */
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
    case 'declined':
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
 * An image link in a reply. Loads without asking only where a web search would; otherwise a card
 * asks first. The link itself is never handed to the browser as an image address.
 */
export function ReplyChatImage({ url, alt }: { url: string; alt: string }) {
  const scope = useChatImageScope();
  const settled = scope?.settled ?? false;
  const source = useMemo<ChatImageSource>(() => ({ kind: 'reply', url }), [url]);
  const { state, approve, decline } = useShowImages({ scope, source, enabled: settled });
  if (scope === null || !settled || state.kind === 'loading') {
    return <Notice testId="aui-chat-image-loading">{alt === '' ? 'Image' : alt}</Notice>;
  }
  switch (state.kind) {
    case 'ask':
      return (
        <AskCard
          question={`Show this image from ${state.host ?? 'the web'}?`}
          detail="That site will see that you looked at it."
          showLabel="Show image"
          onShow={approve}
          onDecline={decline}
          testId="aui-chat-image-ask"
        />
      );
    case 'declined':
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

/** One card per email message: its linked images load only after the person says so. */
export function EmailImagesCard({ toolCallId, count }: { toolCallId: string; count: number }) {
  const scope = useChatImageScope();
  const source = useMemo<ChatImageSource>(() => ({ kind: 'email', tool_call_id: toolCallId }), [toolCallId]);
  const { state, approve, decline } = useShowImages({ scope, source, enabled: true });
  if (scope === null) {
    return null;
  }
  const noun = count === 1 ? 'image' : 'images';
  switch (state.kind) {
    case 'loading':
    case 'ask':
      return (
        <AskCard
          question={`Show ${String(count)} ${noun} from this email?`}
          detail="The sender's servers will see that the email was opened."
          showLabel={count === 1 ? 'Show image' : 'Show images'}
          onShow={approve}
          onDecline={decline}
          testId="aui-email-images-ask"
        />
      );
    case 'declined':
      return (
        <Notice testId="aui-email-images-declined">{`${String(count)} ${noun} from this email not shown.`}</Notice>
      );
    case 'error':
      return <Notice testId="aui-chat-image-error">{CHAT_IMAGE_ERROR_TEXT}</Notice>;
    case 'done':
      return (
        <span className="flex flex-wrap gap-2" data-testid="aui-email-images">
          {state.images.map((outcome, index) => (
            <Outcome key={index} outcome={outcome} alt={`Image ${String(index + 1)} from the email`} scope={scope} />
          ))}
        </span>
      );
  }
}

/** Images a turn produced outside its text: sandbox and tool images, and a card per email that links images. */
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

  if (list === null || (list.artifacts.length === 0 && list.emails.length === 0)) {
    return null;
  }
  return (
    <div className="aui-turn-images mt-2 flex flex-col gap-2" data-testid="aui-turn-images">
      {list.emails.map(email => (
        <EmailImagesCard key={email.tool_call_id} toolCallId={email.tool_call_id} count={email.count} />
      ))}
      {list.artifacts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {list.artifacts.map(artifact => (
            <ArtifactChatImage key={artifact.path} path={artifact.path} alt={artifact.name} />
          ))}
        </div>
      )}
    </div>
  );
}
