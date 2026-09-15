'use client';

import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent } from 'react';

import { useAuiState } from '../assistant-ui.js';
import { useOptionalBugReport, type BugReportApi, type BugReportBundle } from '../components/BugReportContext.js';
import { Icon } from '../icons/Icon.js';
import { getErrorMessage } from '../utils/getErrorMessage.js';
import { auiButtonClass } from './lib/buttonClasses.js';
import { auiInputClass } from './lib/inputClasses.js';
import { Button } from './primitives/Button.js';
import { CenteredModal } from './primitives/CenteredModal.js';

/**
 * Upper bound on the typed description, matching the server's
 * `CreateSessionBugReportRequestSchema.description` `.max(8000)`. Enforced on the textarea so a
 * report can never be composed that the endpoint would deterministically reject.
 */
const DESCRIPTION_MAX_LENGTH = 8000;

/** Triggers a browser download of the bundle as pretty-printed JSON. */
function downloadBundle(bundle: BugReportBundle): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `bug-report-${bundle.session.id}-${bundle.generated_at.replace(/[^0-9]/g, '')}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function bundleSummary(bundle: BugReportBundle): { turns: number; events: number; errors: number } {
  return {
    turns: bundle.trace.length,
    events: bundle.trace.reduce((total, turn) => total + turn.events.length, 0),
    errors: bundle.recent_errors.length,
  };
}

/**
 * "Report a bug" icon button, pinned next to the theme toggle in `ShellActions`. Opens a
 * compact modal to fetch a redacted diagnostic bundle for the current session (assembled
 * server-side — see `packages/trueforge/src/apis/bugReportRedactor.ts`), then download it or
 * copy it to the clipboard. Renders nothing when no host has wired a `BugReportProvider`.
 *
 * The `api == null` check happens here, before any hook that assumes an assistant-ui runtime
 * (`useAuiState`) runs — `ConnectedBugReportButton` below is only mounted once a provider exists,
 * so a host that never wires one never pays for (or risks) that dependency.
 */
export function BugReportButton() {
  const api = useOptionalBugReport();
  if (api == null) {
    return null;
  }
  return <ConnectedBugReportButton api={api} />;
}

function ConnectedBugReportButton({ api }: { api: BugReportApi }) {
  const sessionId = useAuiState(state => state.threadListItem.remoteId);
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  // Off by default and reset with the modal: including the chat is a per-report choice, never sticky.
  const [includeChat, setIncludeChat] = useState(false);
  const [bundle, setBundle] = useState<BugReportBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const descriptionId = useId();
  // Monotonic token for the in-flight generation. A response is committed only while its token is
  // still current; a session switch or a modal close bumps it, so a late response for a previous
  // session can neither repopulate a cleared bundle nor overwrite the active one.
  const generationRef = useRef(0);

  // Invalidate any in-flight generation and drop the generated bundle + status. Leaves the typed
  // description alone; callers decide whether to also clear it.
  const clearGeneratedState = useCallback((): void => {
    generationRef.current += 1;
    setBundle(null);
    setError(null);
    setCopied(false);
    setLoading(false);
  }, []);

  // A session switch must not carry one session's description or bundle into another (findings
  // #2/#7). Reset everything — including the free-text description — whenever the session changes.
  useEffect(() => {
    clearGeneratedState();
    setDescription('');
    setIncludeChat(false);
  }, [sessionId, clearGeneratedState]);

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    if (!next) {
      // Fresh state on the next open — a stale bundle or description from a different session must
      // not linger, and an in-flight generation must not commit after the modal closed.
      clearGeneratedState();
      setDescription('');
      setIncludeChat(false);
    }
  };

  const handleGenerate = (): void => {
    if (sessionId == null || loading) return;
    const requestId = (generationRef.current += 1);
    const requestSessionId = sessionId;
    setLoading(true);
    setError(null);
    void api
      .generateBugReport({ sessionId: requestSessionId, description, includeChat })
      .then(next => {
        if (generationRef.current === requestId) setBundle(next);
      })
      .catch((err: unknown) => {
        if (generationRef.current === requestId) setError(getErrorMessage(err, 'Could not generate the bug report.'));
      })
      .finally(() => {
        if (generationRef.current === requestId) setLoading(false);
      });
  };

  const handleCopy = (): void => {
    if (bundle == null) return;
    // The Clipboard API is absent in insecure contexts and some embedded webviews, where
    // dereferencing navigator.clipboard.writeText throws synchronously rather than rejecting.
    // Guard, then direct the user to Download instead of throwing.
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clipboard?.writeText == null) {
      setError('Clipboard is unavailable in this browser. Use Download (.json) instead.');
      return;
    }
    // A clipboard write that settles after a session switch or modal close must not flip a
    // different session's Copy button to "Copied"; gate the result on the same generation token
    // report generation uses, so a stale write is ignored.
    const requestId = generationRef.current;
    void clipboard
      .writeText(JSON.stringify(bundle, null, 2))
      .then(() => {
        if (generationRef.current !== requestId) return;
        setCopied(true);
        window.setTimeout(() => {
          if (generationRef.current === requestId) setCopied(false);
        }, 1500);
      })
      .catch(() => {
        if (generationRef.current === requestId) {
          setError('Could not copy to the clipboard. Use Download (.json) instead.');
        }
      });
  };

  const summary = bundle ? bundleSummary(bundle) : null;

  return (
    <>
      <button
        type="button"
        aria-label="Report a bug"
        title="Report a bug"
        className={auiButtonClass({ variant: 'ghost', size: 'icon' })}
        onClick={() => setOpen(true)}
      >
        <Icon name="bug" />
      </button>

      <CenteredModal
        open={open}
        onOpenChange={handleOpenChange}
        title="Report a bug"
        description="Assembles a redacted diagnostic bundle for this chat — no memory content, tool arguments, or credentials, and no message text unless you choose to include it below."
        contentSized
      >
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <label
                htmlFor={descriptionId}
                className="text-xs font-semibold tracking-wide text-text-secondary uppercase"
              >
                What went wrong?
              </label>
              <span className="text-[11px] tabular-nums text-text-secondary" aria-live="polite">
                {description.length.toLocaleString()}/{DESCRIPTION_MAX_LENGTH.toLocaleString()}
              </span>
            </div>
            <textarea
              id={descriptionId}
              className={auiInputClass('h-24 resize-none py-2')}
              placeholder="Optional — describe what you expected vs. what happened."
              value={description}
              maxLength={DESCRIPTION_MAX_LENGTH}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDescription(event.target.value)}
            />
          </div>

          <label className="flex items-start gap-2 text-xs text-text-primary">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={includeChat}
              disabled={sessionId == null || loading}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setIncludeChat(event.target.checked)}
            />
            <span>
              Include this chat&apos;s messages
              <span className="block text-text-secondary">
                Off by default. Adds what you and the assistant said, so the reader can follow the report. Tool
                arguments, memory content, and credentials still stay out.
              </span>
            </span>
          </label>

          {sessionId == null ? (
            <p className="text-xs text-text-secondary" role="status">
              Start or open a chat to generate a report for it.
            </p>
          ) : null}

          {error != null ? (
            <p className="text-xs text-failure-bg" role="alert">
              {error}
            </p>
          ) : null}

          <Button type="button" variant="primary" disabled={sessionId == null || loading} onClick={handleGenerate}>
            {loading ? 'Generating…' : bundle != null ? 'Regenerate report' : 'Generate report'}
          </Button>

          {bundle != null && summary != null ? (
            <>
              <details className="group overflow-hidden rounded-lg border border-border bg-card-bg">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-text-primary [&::-webkit-details-marker]:hidden">
                  <Icon name="chevron-down" size={13} className="shrink-0 transition-transform group-open:rotate-180" />
                  <span>
                    What&apos;s included ({summary.turns} turn{summary.turns === 1 ? '' : 's'}, {summary.events} event
                    {summary.events === 1 ? '' : 's'}
                    {summary.errors > 0 ? `, ${String(summary.errors)} error${summary.errors === 1 ? '' : 's'}` : ''}
                    {bundle.chat
                      ? `, ${String(bundle.chat.messages.length)} chat message${bundle.chat.messages.length === 1 ? '' : 's'}`
                      : ''}
                    )
                  </span>
                </summary>
                <div className="border-t border-border px-3 py-2 text-xs text-text-secondary">
                  <p>
                    Build {bundle.build.version}
                    {bundle.build.ref ? ` (${bundle.build.ref})` : ''} · session {bundle.session.id}
                  </p>
                  <p className="mt-1">
                    Model {bundle.session.model ?? 'unknown'} · connectors{' '}
                    {bundle.session.connectors.length > 0 ? bundle.session.connectors.join(', ') : 'none'} · skills{' '}
                    {bundle.session.skills.length > 0 ? bundle.session.skills.join(', ') : 'none'} · sandbox{' '}
                    {bundle.session.sandbox_enabled ? 'on' : 'off'}
                  </p>
                  {bundle.summary.length > 0 ? (
                    <ol className="mt-2 list-decimal space-y-1 pl-4 text-text-primary" aria-label="What happened">
                      {bundle.summary.map((line, index) => (
                        <li key={index}>{line}</li>
                      ))}
                    </ol>
                  ) : null}
                  {bundle.recent_errors.length > 0 ? (
                    <ul className="mt-2 space-y-0.5" aria-label="Errors">
                      {bundle.recent_errors.map((item, index) => (
                        <li key={index}>
                          {item.event_type}
                          {item.code ? ` (${item.code})` : ''}: {item.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="mt-1">{bundle.redaction.notes}</p>
                  <pre className="mt-2 max-h-48 overflow-auto rounded bg-primary-bg p-2 text-[11px] leading-snug whitespace-pre-wrap">
                    {JSON.stringify(bundle, null, 2)}
                  </pre>
                </div>
              </details>

              <div className="flex gap-2">
                <Button type="button" variant="secondary" className="flex-1" onClick={() => downloadBundle(bundle)}>
                  <Icon name="download" className="size-3.5" />
                  Download (.json)
                </Button>
                <Button type="button" variant="secondary" className="flex-1" onClick={handleCopy}>
                  <Icon name={copied ? 'check' : 'clone'} className="size-3.5" />
                  {copied ? 'Copied' : 'Copy to clipboard'}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </CenteredModal>
    </>
  );
}
