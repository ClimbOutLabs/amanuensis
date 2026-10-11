'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/atoms/lib/cn.js';
import { Button } from '@/atoms/primitives/Button.js';
import { Spinner } from '@/atoms/primitives/Spinner.js';
import { useOptionalRunCodeStatus, type RunCodeStatus } from '@/components/RunCodeStatusContext.js';
import { useServerCapabilities } from '@/server/ServerContext.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';

import {
  formatMebibytes,
  formatSeconds,
  presentRunCodeStatus,
  type Check,
  type StatusTone,
} from './runCodeStatusPresentation.js';
import { readSandboxLimits, type SandboxLimits } from './sandboxIsolationCapability.js';

const TONE_TEXT: Record<StatusTone, string> = {
  success: 'text-success-bg',
  warning: 'text-warning-bg',
  failure: 'text-failure-bg',
  neutral: 'text-text-primary',
};

const TONE_DOT: Record<StatusTone, string> = {
  success: 'bg-success-bg',
  warning: 'bg-warning-bg',
  failure: 'bg-failure-bg',
  neutral: 'bg-border',
};

function StatusPill({ tone, text }: { tone: StatusTone; text: string }) {
  return (
    <span
      className={cn(
        'flex w-fit items-center gap-1.5 rounded-full border border-border bg-secondary-bg/40 px-2 py-0.5 text-xs font-medium',
        TONE_TEXT[tone],
      )}
      role="status"
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[tone])} aria-hidden />
      {text}
    </span>
  );
}

function Card({ headingId, title, children }: { headingId: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-border bg-card-bg p-4">
      <h4 id={headingId} className="text-sm font-medium text-text-primary">
        {title}
      </h4>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="shrink-0 text-text-secondary">{label}</dt>
      <dd className="min-w-0 text-text-primary sm:text-right">{children}</dd>
    </div>
  );
}

function CheckValue({ check }: { check: Check }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[check.tone])} aria-hidden />
      {check.text}
    </span>
  );
}

function ImageCard({ status, limits }: { status: RunCodeStatus; limits: SandboxLimits | null }) {
  const { image, signature } = presentRunCodeStatus(status);
  return (
    <Card headingId="sandbox-image-heading" title="Image">
      <dl className="mt-2 divide-y divide-border text-sm">
        {limits !== null && limits.image !== '' ? (
          <Row label="Version">
            <span className="break-all font-mono text-[0.8125rem]">{limits.image}</span>
          </Row>
        ) : null}
        <Row label="Download">
          <CheckValue check={image} />
        </Row>
        <Row label="Signature">
          <CheckValue check={signature} />
        </Row>
      </dl>
    </Card>
  );
}

function LimitsCard({ limits }: { limits: SandboxLimits | null }) {
  return (
    <Card headingId="sandbox-limits-heading" title="Limits for each run">
      {limits === null ? (
        <p className="mt-2 text-sm text-text-secondary">
          The server did not report its limits. Check that it is up to date.
        </p>
      ) : (
        <>
          <dl className="mt-2 divide-y divide-border text-sm">
            <Row label="Time">
              {formatSeconds(limits.defaultTimeoutSeconds)} by default, at most{' '}
              {formatSeconds(limits.maxTimeoutSeconds)}
            </Row>
            <Row label="Memory">{formatMebibytes(limits.memoryMb)}</Row>
            <Row label="Disk space">{formatMebibytes(limits.diskMb)} for files the code writes</Row>
            <Row label="Network">
              {limits.networkEgress ? 'On' : 'Off. Code cannot reach the internet or your network.'}
            </Row>
          </dl>
          <p className="mt-2 border-t border-border pt-3 text-xs text-text-secondary">
            Set by the server configuration. Changing them takes a restart.
          </p>
        </>
      )}
    </Card>
  );
}

function RecheckButton({ checking, onClick }: { checking: boolean; onClick: () => void }) {
  return (
    <Button.Secondary size="small" type="button" disabled={checking} onClick={onClick}>
      {checking ? <Spinner size={14} aria-hidden /> : null}
      {checking ? 'Checking…' : 'Re-check'}
    </Button.Secondary>
  );
}

function StatusCard({
  status,
  checking,
  onRecheck,
}: {
  status: RunCodeStatus;
  checking: boolean;
  onRecheck: () => void;
}) {
  const presentation = presentRunCodeStatus(status);
  return (
    <Card headingId="sandbox-status-heading" title="Status">
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <StatusPill tone={presentation.tone} text={presentation.pill} />
          <p className="mt-2 text-sm font-medium text-text-primary">{presentation.headline}</p>
          <p className="mt-0.5 text-sm text-text-secondary">{presentation.summary}</p>
        </div>
        <RecheckButton checking={checking} onClick={onRecheck} />
      </div>
      {presentation.fix === undefined ? null : (
        <div className="mt-3 rounded-lg border border-border bg-secondary-bg/40 p-3 text-sm">
          <p className="font-medium text-text-primary">What to do</p>
          <p className="mt-0.5 text-text-secondary">{presentation.fix}</p>
        </div>
      )}
      {status.detail === undefined ? null : (
        <details className="mt-3 text-xs text-text-secondary">
          <summary className="cursor-pointer select-none">Technical details</summary>
          <p className="mt-1.5 whitespace-pre-wrap break-words font-mono">{status.detail}</p>
        </details>
      )}
    </Card>
  );
}

function CheckingCard() {
  return (
    <Card headingId="sandbox-status-heading" title="Status">
      <div className="mt-2 flex items-center gap-2 text-sm text-text-secondary" role="status" aria-live="polite">
        <Spinner size={16} aria-hidden />
        Checking Docker, the sandbox image and its signature. This can take a few seconds.
      </div>
    </Card>
  );
}

function ErrorCard({ message, checking, onRetry }: { message: string; checking: boolean; onRetry: () => void }) {
  return (
    <Card headingId="sandbox-status-heading" title="Status">
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3" role="alert">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-failure-bg">Could not check the sandbox status</p>
          <p className="mt-0.5 text-sm text-text-secondary">
            The server did not answer the status check ({message}). Nothing about the sandbox has changed. Try again in
            a moment.
          </p>
        </div>
        <Button.Secondary size="small" type="button" disabled={checking} onClick={onRetry}>
          {checking ? 'Trying…' : 'Try again'}
        </Button.Secondary>
      </div>
    </Card>
  );
}

/** Settings > Sandbox: the Docker sandbox that runs code for the assistant, and whether it can run now. */
const SandboxSettings = () => {
  const api = useOptionalRunCodeStatus();
  const limits = readSandboxLimits(useServerCapabilities());
  const [status, setStatus] = useState<RunCodeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  // Only the latest check may write state, so a slow earlier answer cannot overwrite a newer one.
  const latestCheck = useRef(0);

  const check = useCallback(async () => {
    if (api === null) return;
    latestCheck.current += 1;
    const current = latestCheck.current;
    setChecking(true);
    setError(null);
    try {
      const next = await api.getRunCodeStatus();
      if (current === latestCheck.current) setStatus(next);
    } catch (err) {
      if (current === latestCheck.current) {
        setStatus(null);
        setError(getErrorMessage(err, 'unknown error'));
      }
    } finally {
      if (current === latestCheck.current) setChecking(false);
    }
  }, [api]);

  useEffect(() => {
    void check();
    return () => {
      latestCheck.current += 1;
    };
  }, [check]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto pb-1">
      <header>
        <h3 className="text-base font-semibold text-text-primary">Sandbox</h3>
        <p className="mt-1 text-sm text-text-secondary">
          Runs the Python and Node.js code the assistant writes, in an isolated Docker container with no network access.
        </p>
      </header>

      {status !== null ? (
        <>
          <StatusCard
            status={status}
            checking={checking}
            onRecheck={() => {
              void check();
            }}
          />
          <ImageCard status={status} limits={limits} />
        </>
      ) : error !== null ? (
        <ErrorCard
          message={error}
          checking={checking}
          onRetry={() => {
            void check();
          }}
        />
      ) : (
        <CheckingCard />
      )}

      <LimitsCard limits={limits} />
    </div>
  );
};

export default SandboxSettings;
