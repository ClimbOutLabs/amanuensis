'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/atoms/lib/cn.js';
import { Button } from '@/atoms/primitives/Button.js';
import { Spinner } from '@/atoms/primitives/Spinner.js';
import { Switch } from '@/atoms/primitives/Switch.js';
import { useOptionalRepositoryWork, type RepositorySummary } from '@/components/RepositoryWorkContext.js';
import { useOptionalRunCodeStatus, type RunCodeStatus } from '@/components/RunCodeStatusContext.js';
import { useOptionalSentinelApiState } from '@/sentinel/SentinelApiContext.js';
import { useServerCapabilities } from '@/server/ServerContext.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';

import {
  formatCheckedAgo,
  formatMegabytes,
  formatSeconds,
  presentRunCodeStatus,
  shortImageName,
  type StatusTone,
} from './runCodeStatusPresentation.js';
import { readSandboxLimits, type SandboxLimits } from './sandboxIsolationCapability.js';

const CLOCK_TICK_MS = 30_000;

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
  neutral: 'bg-text-secondary',
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

function ChecksValue({ tone, text }: { tone: StatusTone; text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone])} aria-hidden />
      {text}
    </span>
  );
}

function ImageCard({ status, limits }: { status: RunCodeStatus; limits: SandboxLimits | null }) {
  if (status.backend === 'slots') return null;
  const { checks } = presentRunCodeStatus(status);
  if ((limits === null || limits.image === '') && checks.length === 0) return null;
  return (
    <Card headingId="sandbox-image-heading" title="Image">
      <dl className="mt-2 divide-y divide-border text-sm">
        {limits !== null && limits.image !== '' ? <Row label="Version">{shortImageName(limits.image)}</Row> : null}
        {checks.map(check => (
          <Row key={check.label} label={check.label}>
            <ChecksValue tone={check.tone} text={check.text} />
          </Row>
        ))}
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
        <dl className="mt-2 divide-y divide-border text-sm">
          <Row label="Time">
            {formatSeconds(limits.defaultTimeoutSeconds)} by default, at most {formatSeconds(limits.maxTimeoutSeconds)}
          </Row>
          <Row label="Memory">{formatMegabytes(limits.memoryMb)}</Row>
          <Row label="Disk space">{formatMegabytes(limits.diskMb)} for files the code writes</Row>
          <Row label="Network">
            {limits.networkEgress ? 'On' : 'Off. Code cannot reach the internet or your network.'}
          </Row>
        </dl>
      )}
    </Card>
  );
}

function TechnicalDetails({ lines }: { lines: Array<{ label: string; value: string }> }) {
  return (
    <details className="mt-3 text-xs text-text-secondary">
      <summary className="cursor-pointer select-none">Technical details</summary>
      <dl className="mt-1.5 space-y-1.5">
        {lines.map(line => (
          <div key={line.label}>
            <dt className="inline">{line.label}: </dt>
            <dd className="inline whitespace-pre-wrap break-words font-mono">{line.value}</dd>
          </div>
        ))}
      </dl>
    </details>
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

const LIMIT_SETTINGS =
  'SANDBOX_DEFAULT_TIMEOUT_SECONDS, SANDBOX_MAX_TIMEOUT_SECONDS, SANDBOX_MEMORY_MB, SANDBOX_DISK_MB (change only with a restart)';

function StatusCard({
  status,
  limits,
  checkedAt,
  checking,
  onRecheck,
}: {
  status: RunCodeStatus;
  limits: SandboxLimits | null;
  checkedAt: number | null;
  checking: boolean;
  onRecheck: () => void;
}) {
  const presentation = presentRunCodeStatus(status);
  const now = useNow();
  const lines = [
    ...(limits !== null && limits.image !== '' && status.backend !== 'slots'
      ? [{ label: 'Image', value: limits.image }]
      : []),
    ...(presentation.settings === undefined ? [] : [{ label: 'Server settings', value: presentation.settings }]),
    { label: 'Limits set by', value: LIMIT_SETTINGS },
    ...(status.detail === undefined ? [] : [{ label: 'Details', value: status.detail }]),
  ];
  return (
    <Card headingId="sandbox-status-heading" title="Status">
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={presentation.tone} text={presentation.pill} />
            {checkedAt === null ? null : (
              <span className="text-xs text-text-secondary">Last checked {formatCheckedAgo({ checkedAt, now })}</span>
            )}
          </div>
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
      <TechnicalDetails lines={lines} />
    </Card>
  );
}

/**
 * Settings > Sandbox > Package downloads: one switch per repository, and one for chats that are
 * not working on a project. Downloads come only through the download-only mirrors; nothing can be
 * published or uploaded. Turning a switch off stops its downloads at once, including in chats
 * already running. The list shows only where the host provides the repository and settings APIs.
 */
function PackageDownloadsCard() {
  const repositoryWork = useOptionalRepositoryWork();
  const sentinel = useOptionalSentinelApiState();
  const [repositories, setRepositories] = useState<RepositorySummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (repositoryWork === null) return;
    let current = true;
    repositoryWork
      .listRepositories()
      .then(list => {
        if (current) setRepositories(list);
      })
      .catch((err: unknown) => {
        if (current) setError(getErrorMessage(err, 'unknown error'));
      });
    return () => {
      current = false;
    };
  }, [repositoryWork]);

  if (repositoryWork === null && sentinel === null) return null;

  const downloadsWithoutProject = sentinel?.settings?.package_downloads_without_project_allowed ?? false;

  const handleRepositoryChange = async (repository: RepositorySummary, next: boolean) => {
    if (repositoryWork === null) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await repositoryWork.setRepositoryPackageDownloads({ repositoryId: repository.id, allowed: next });
      setRepositories(current =>
        current === null ? current : current.map(item => (item.id === saved.id ? saved : item)),
      );
    } catch (err) {
      setError(getErrorMessage(err, 'unknown error'));
    } finally {
      setBusy(false);
    }
  };

  const handleWithoutProjectChange = async (next: boolean) => {
    if (sentinel === null) return;
    setBusy(true);
    setError(null);
    try {
      await sentinel.updateSettings({ package_downloads_without_project_allowed: next });
    } catch (err) {
      setError(getErrorMessage(err, 'unknown error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card headingId="sandbox-package-downloads-heading" title="Package downloads">
      <p className="mt-2 text-sm text-text-secondary">
        Packages come only through the download-only mirrors, so nothing can be published or uploaded. The first
        download in a place asks you first. Turning a switch off stops its downloads at once, including in chats already
        running.
      </p>
      {error !== null && (
        <p className="mt-2 text-xs text-failure-bg" role="alert">
          {error}
        </p>
      )}
      <ul className="mt-3 space-y-2">
        {(repositories ?? []).map(repository => (
          <li key={repository.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 text-text-primary">{repository.name}</span>
            <Switch
              size="md"
              checked={repository.package_downloads_allowed}
              disabled={busy}
              onCheckedChange={next => {
                void handleRepositoryChange(repository, next);
              }}
              aria-label={`Package downloads for ${repository.name}`}
            />
          </li>
        ))}
        {sentinel !== null && (
          <li className="flex items-start justify-between gap-4 text-sm">
            <div>
              <p className="font-medium text-text-primary">Chats without a project</p>
              <p className="mt-1 text-text-secondary">
                Downloads in chats that are not working on a project. This allowance also covers scheduled runs.
              </p>
            </div>
            <Switch
              size="md"
              checked={downloadsWithoutProject}
              disabled={busy || sentinel.settings === null}
              onCheckedChange={next => {
                void handleWithoutProjectChange(next);
              }}
              aria-label="Package downloads in chats without a project"
            />
          </li>
        )}
      </ul>
      {repositoryWork !== null && repositories === null && error === null && (
        <p className="mt-2 text-sm text-text-secondary">Reading your projects…</p>
      )}
    </Card>
  );
}

/** Wall-clock time that re-renders every half minute so "Last checked" stays honest. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, CLOCK_TICK_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  return now;
}

function CheckingCard() {
  return (
    <Card headingId="sandbox-status-heading" title="Status">
      <div className="mt-2 flex items-center gap-2 text-sm text-text-secondary" role="status" aria-live="polite">
        <Spinner size={16} aria-hidden />
        Checking the sandbox. This can take a few seconds.
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
            The status check did not get an answer from the server. Nothing about the sandbox has changed. Try again in
            a moment.
          </p>
        </div>
        <Button.Secondary size="small" type="button" disabled={checking} onClick={onRetry}>
          {checking ? 'Trying…' : 'Try again'}
        </Button.Secondary>
      </div>
      <TechnicalDetails lines={[{ label: 'Error', value: message }]} />
    </Card>
  );
}

/** Settings > Sandbox: the Docker sandbox that runs code for the assistant, and whether it can run now. */
const SandboxSettings = () => {
  const api = useOptionalRunCodeStatus();
  const limits = readSandboxLimits(useServerCapabilities());
  const [status, setStatus] = useState<RunCodeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
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
      if (current === latestCheck.current) {
        setStatus(next);
        setCheckedAt(Date.now());
      }
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
          {status === null
            ? 'Runs the code the assistant writes in an isolated sandbox with no network access.'
            : status.backend === 'slots'
              ? 'Runs the Python, Node.js and shell commands the assistant writes, in isolated sandboxes with no network access.'
              : 'Runs the Python and Node.js code the assistant writes, in an isolated Docker container with no network access.'}
        </p>
      </header>

      {status !== null ? (
        <>
          <StatusCard
            status={status}
            limits={limits}
            checkedAt={checkedAt}
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
      <PackageDownloadsCard />
    </div>
  );
};

export default SandboxSettings;
