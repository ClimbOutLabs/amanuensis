'use client';

import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent } from 'react';

import { useAuiState } from '../assistant-ui.js';
import {
  useOptionalBugReport,
  useOptionalBugReportDialog,
  type AppBugReportBundle,
  type BugReportApi,
  type BugReportBundle,
  type BugReportDialogControl,
  type BugReportHandoffTarget,
} from '../components/BugReportContext.js';
import { Icon } from '../icons/Icon.js';
import { buildHandoffTitle, buildIssuePrefillUrl, summarizeBundleForIssue } from '../utils/bugReportHandoff.js';
import { getErrorMessage } from '../utils/getErrorMessage.js';
import { auiButtonClass, railMenuRowClassName } from './lib/buttonClasses.js';
import { auiInputClass } from './lib/inputClasses.js';
import { Button } from './primitives/Button.js';
import { CenteredModal } from './primitives/CenteredModal.js';

/**
 * Upper bound on the typed description, matching the server's
 * `CreateSessionBugReportRequestSchema.description` `.max(8000)`. Enforced on the textarea so a
 * report can never be composed that the endpoint would deterministically reject.
 */
const DESCRIPTION_MAX_LENGTH = 8000;

type GeneratedReport = { kind: 'session'; bundle: BugReportBundle } | { kind: 'app'; bundle: AppBugReportBundle };

function isSessionReport(report: GeneratedReport): report is { kind: 'session'; bundle: BugReportBundle } {
  return report.kind === 'session';
}

/** Triggers a browser download of the bundle as pretty-printed JSON. */
function downloadBundle(report: GeneratedReport): void {
  // Read `session.id` off `report.bundle` (not a destructured copy) so the `isSessionReport`
  // guard narrows the union: the app-level bundle has no `session` key by design.
  const stamp = report.bundle.generated_at.replace(/[^0-9]/g, '');
  const name = isSessionReport(report)
    ? `bug-report-${report.bundle.session.id}-${stamp}.json`
    : `bug-report-app-${stamp}.json`;
  const blob = new Blob([JSON.stringify(report.bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function sessionBundleSummary(bundle: BugReportBundle): { turns: number; events: number; errors: number } {
  return {
    turns: bundle.trace.length,
    events: bundle.trace.reduce((total, turn) => total + turn.events.length, 0),
    errors: bundle.recent_errors.length,
  };
}

/** A menu row unmounts as it opens the dialog, so focus goes back to the menu's trigger instead. */
function focusTargetFor(button: HTMLElement): HTMLElement {
  const menuId = button.closest('[role="menu"]')?.id;
  if (menuId == null || menuId === '') return button;
  return document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menuId)}"]`) ?? button;
}

/**
 * "Report a bug" button: an icon, or a labeled row for menus. Opens the app's bug report form.
 * Renders nothing when no host has wired a `BugReportProvider`.
 */
export function BugReportButton({
  row = false,
}: {
  /** Draws a labeled menu row, as in the rail's More menu, instead of an icon. */
  row?: boolean;
}) {
  const dialog = useOptionalBugReportDialog();
  if (dialog == null) {
    return null;
  }
  return (
    <button
      type="button"
      aria-label="Report a bug"
      title="Report a bug"
      className={
        row
          ? auiButtonClass({ variant: 'ghost', className: railMenuRowClassName })
          : auiButtonClass({ variant: 'ghost', size: 'icon' })
      }
      onClick={event => {
        dialog.returnFocusRef.current = focusTargetFor(event.currentTarget);
        dialog.setOpen(true);
      }}
    >
      <Icon name="bug" size={row ? 14 : undefined} />
      {row ? 'Report a bug' : null}
    </button>
  );
}

/**
 * The bug report form, mounted once by the app shell. The null checks run before
 * `ConnectedBugReportDialog`, which needs an assistant-ui runtime (`useAuiState`).
 */
export function BugReportDialog() {
  const api = useOptionalBugReport();
  const dialog = useOptionalBugReportDialog();
  if (api == null || dialog == null) {
    return null;
  }
  return <ConnectedBugReportDialog api={api} dialog={dialog} />;
}

function ConnectedBugReportDialog({ api, dialog }: { api: BugReportApi; dialog: BugReportDialogControl }) {
  const sessionId = useAuiState(state => state.threadListItem.remoteId);
  const { open, setOpen, registerDialog, returnFocusRef } = dialog;
  useEffect(registerDialog, [registerDialog]);
  const [description, setDescription] = useState('');
  // Off by default and reset with the modal: including the chat is a per-report choice, never sticky.
  const [includeChat, setIncludeChat] = useState(false);
  const [report, setReport] = useState<GeneratedReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [handoff, setHandoff] = useState<BugReportHandoffTarget | 'loading'>(null);
  const descriptionId = useId();
  // Monotonic token for the in-flight generation. A response is committed only while its token is
  // still current; a session switch or a modal close bumps it, so a late response for a previous
  // session can neither repopulate a cleared bundle nor overwrite the active one.
  const generationRef = useRef(0);
  // Separate token for the in-flight handoff-target lookup: it is tied to the modal being open,
  // not to a generation, so generating a report must not invalidate it.
  const handoffRequestRef = useRef(0);

  // Invalidate any in-flight generation and drop the generated report + status. Leaves the typed
  // description alone; callers decide whether to also clear it.
  const clearGeneratedState = useCallback((): void => {
    generationRef.current += 1;
    setReport(null);
    setError(null);
    setCopied(false);
    setLoading(false);
  }, []);

  // A session switch must not carry one session's description or report into another. Reset
  // everything — including the free-text description — whenever the session changes.
  useEffect(() => {
    clearGeneratedState();
    setDescription('');
    setIncludeChat(false);
  }, [sessionId, clearGeneratedState]);

  // Read through a ref so a host passing a fresh `api` object each render does not rerun the lookup.
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  // Resolve the handoff target once per open. A host without one configured simply gets no
  // "File on GitHub" button, and a failure here must not block the rest of the modal.
  useEffect(() => {
    if (!open) return;
    setHandoff('loading');
    const requestId = (handoffRequestRef.current += 1);
    void apiRef.current
      .getBugReportHandoff()
      .then(target => {
        if (handoffRequestRef.current === requestId) setHandoff(target);
      })
      .catch(() => {
        if (handoffRequestRef.current === requestId) setHandoff(null);
      });
    // Closing bumps the token, so a lookup that settles after the dialog closed is ignored.
    return () => {
      handoffRequestRef.current += 1;
    };
  }, [open]);

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    if (next) return;
    // Fresh state on the next open: a stale report or description from a different session must
    // not linger, and an in-flight generation must not commit after the modal closed.
    clearGeneratedState();
    setDescription('');
    setIncludeChat(false);
    setHandoff(null);
  };

  // Runs after the modal has closed, when the page behind it can take focus again.
  useEffect(() => {
    if (open) return;
    const returnTo = returnFocusRef.current;
    returnFocusRef.current = null;
    if (returnTo?.isConnected) returnTo.focus();
  }, [open, returnFocusRef]);

  const handleGenerate = (): void => {
    if (loading) return;
    const requestId = (generationRef.current += 1);
    setLoading(true);
    setError(null);
    const pending: Promise<GeneratedReport> =
      sessionId == null
        ? api.generateAppBugReport({ description }).then((bundle): GeneratedReport => ({ kind: 'app', bundle }))
        : api
            .generateBugReport({ sessionId, description, includeChat })
            .then((bundle): GeneratedReport => ({ kind: 'session', bundle }));
    void pending
      .then(next => {
        if (generationRef.current === requestId) setReport(next);
      })
      .catch((err: unknown) => {
        if (generationRef.current === requestId) setError(getErrorMessage(err, 'Could not generate the bug report.'));
      })
      .finally(() => {
        if (generationRef.current === requestId) setLoading(false);
      });
  };

  const handleCopy = (): void => {
    if (report == null) return;
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
      .writeText(JSON.stringify(report.bundle, null, 2))
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

  const handleHandoff = (): void => {
    if (report == null || handoff == null || handoff === 'loading') return;
    // Only the redacted bundle (plus the reporter's own description) reaches the issue: the
    // handoff helpers never read session data, message text, or tool I/O.
    const fields = summarizeBundleForIssue(report.bundle);
    const url = buildIssuePrefillUrl({
      baseIssueUrl: handoff.issueUrl,
      title: buildHandoffTitle(description),
      fields: { ...fields, whatHappened: description === '' ? undefined : description },
    });
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const sessionSummary = report != null && isSessionReport(report) ? sessionBundleSummary(report.bundle) : null;
  const showHandoff = handoff != null && handoff !== 'loading';
  const modalDescription =
    sessionId == null
      ? 'Assembles a redacted app diagnostic bundle — build version and config flags only. No chat, session, or message data is included.'
      : 'Assembles a redacted diagnostic bundle for this chat — no memory content, tool arguments, or credentials, and no message text unless you choose to include it below.';

  return (
    <>
      <CenteredModal
        open={open}
        onOpenChange={handleOpenChange}
        title="Report a bug"
        description={modalDescription}
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

          {sessionId != null ? (
            <label className="flex items-start gap-2 text-xs text-text-primary">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={includeChat}
                disabled={loading}
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
          ) : (
            <p className="text-xs text-text-secondary" role="status">
              No chat open — this files an app-level report instead of a session report.
            </p>
          )}

          {error != null ? (
            <p className="text-xs text-failure-bg" role="alert">
              {error}
            </p>
          ) : null}

          <Button type="button" variant="primary" disabled={loading} onClick={handleGenerate}>
            {loading ? 'Generating…' : report != null ? 'Regenerate report' : 'Generate report'}
          </Button>

          {report != null ? (
            <>
              {isSessionReport(report) && sessionSummary != null ? (
                <details className="group overflow-hidden rounded-lg border border-border bg-card-bg">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-text-primary [&::-webkit-details-marker]:hidden">
                    <Icon
                      name="chevron-down"
                      size={13}
                      className="shrink-0 transition-transform group-open:rotate-180"
                    />
                    <span>
                      What&apos;s included ({sessionSummary.turns} turn{sessionSummary.turns === 1 ? '' : 's'},{' '}
                      {sessionSummary.events} event{sessionSummary.events === 1 ? '' : 's'}
                      {sessionSummary.errors > 0
                        ? `, ${String(sessionSummary.errors)} error${sessionSummary.errors === 1 ? '' : 's'}`
                        : ''}
                      {report.bundle.chat
                        ? `, ${String(report.bundle.chat.messages.length)} chat message${report.bundle.chat.messages.length === 1 ? '' : 's'}`
                        : ''}
                      )
                    </span>
                  </summary>
                  <div className="border-t border-border px-3 py-2 text-xs text-text-secondary">
                    <p>
                      Build {report.bundle.build.version}
                      {report.bundle.build.ref ? ` (${report.bundle.build.ref})` : ''} · session{' '}
                      {report.bundle.session.id}
                    </p>
                    <p className="mt-1">
                      Model {report.bundle.session.model ?? 'unknown'} · connectors{' '}
                      {report.bundle.session.connectors.length > 0
                        ? report.bundle.session.connectors.join(', ')
                        : 'none'}{' '}
                      · skills{' '}
                      {report.bundle.session.skills.length > 0 ? report.bundle.session.skills.join(', ') : 'none'} ·
                      sandbox {report.bundle.session.sandbox_enabled ? 'on' : 'off'}
                    </p>
                    {report.bundle.summary.length > 0 ? (
                      <ol className="mt-2 list-decimal space-y-1 pl-4 text-text-primary" aria-label="What happened">
                        {report.bundle.summary.map((line, index) => (
                          <li key={index}>{line}</li>
                        ))}
                      </ol>
                    ) : null}
                    {report.bundle.recent_errors.length > 0 ? (
                      <ul className="mt-2 space-y-0.5" aria-label="Errors">
                        {report.bundle.recent_errors.map((item, index) => (
                          <li key={index}>
                            {item.event_type}
                            {item.code ? ` (${item.code})` : ''}: {item.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <p className="mt-1">{report.bundle.redaction.notes}</p>
                    <pre className="mt-2 max-h-48 overflow-auto rounded bg-primary-bg p-2 text-[11px] leading-snug whitespace-pre-wrap">
                      {JSON.stringify(report.bundle, null, 2)}
                    </pre>
                  </div>
                </details>
              ) : (
                <details className="group overflow-hidden rounded-lg border border-border bg-card-bg">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-text-primary [&::-webkit-details-marker]:hidden">
                    <Icon
                      name="chevron-down"
                      size={13}
                      className="shrink-0 transition-transform group-open:rotate-180"
                    />
                    <span>What&apos;s included (app-level, no session data)</span>
                  </summary>
                  <div className="border-t border-border px-3 py-2 text-xs text-text-secondary">
                    <p>
                      Build {report.bundle.build.version}
                      {report.bundle.build.ref ? ` (${report.bundle.build.ref})` : ''}
                    </p>
                    <p className="mt-1">{report.bundle.redaction.notes}</p>
                    <pre className="mt-2 max-h-48 overflow-auto rounded bg-primary-bg p-2 text-[11px] leading-snug whitespace-pre-wrap">
                      {JSON.stringify(report.bundle, null, 2)}
                    </pre>
                  </div>
                </details>
              )}

              <div className="flex gap-2">
                <Button type="button" variant="secondary" className="flex-1" onClick={() => downloadBundle(report)}>
                  <Icon name="download" className="size-3.5" />
                  Download (.json)
                </Button>
                <Button type="button" variant="secondary" className="flex-1" onClick={handleCopy}>
                  <Icon name={copied ? 'check' : 'clone'} className="size-3.5" />
                  {copied ? 'Copied' : 'Copy to clipboard'}
                </Button>
                {showHandoff ? (
                  <Button type="button" variant="secondary" className="flex-1" onClick={handleHandoff}>
                    <Icon name="github" className="size-3.5" />
                    File on GitHub
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </CenteredModal>
    </>
  );
}
