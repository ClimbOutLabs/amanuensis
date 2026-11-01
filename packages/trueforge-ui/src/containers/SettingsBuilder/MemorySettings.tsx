'use client';

import { useTrueFoundryAgentSpec } from '@truefoundry/assistant-ui-runtime';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { useEffect, useState, type ReactNode } from 'react';

import { cn } from '@/atoms/lib/cn.js';
import { Switch } from '@/atoms/primitives/Switch.js';
import { readMemoryBackend } from '@/plugins/trueforge-agent-server-adapter/lists.js';
import {
  useOptionalRefreshServerCapabilities,
  useServerCapabilities,
  useServerCapabilitiesSettled,
} from '@/server/ServerContext.js';
import { useAssistantDisplayName } from '../../components/PersonalizationContext.js';
import { useToasterOptional } from '../ToasterContainer.js';
import { readMemoryEmbeddingsStatus, type MemoryEmbeddingsStatus } from './memoryEmbeddingsCapability.js';
import { useMemoryRecallSetting } from './memoryRecallSetting.js';
import { readMemoryScreenStatus, readToolOutputScreenStatus } from './memoryScreenCapability.js';
import { useMemoryScreenSetting } from './memoryScreenSetting.js';
import { readMemoryStorageDir } from './memoryStorageCapability.js';
import { useMemorySummarizeSetting, type MemorySummarizeSettingState } from './memorySummarizeSetting.js';
import { useToolOutputScreenSetting } from './toolOutputScreenSetting.js';

type ScreenStatus = { enabled: boolean; threshold?: number; timeoutMs?: number } | null;
type ScreenState = 'on' | 'off' | 'unavailable';

function screenStateOf(status: ScreenStatus): ScreenState {
  return status === null ? 'unavailable' : status.enabled ? 'on' : 'off';
}

function ScreenStatusCard(props: {
  headingId: string;
  title: string;
  description: string;
  status: ScreenStatus;
  enabledText: string;
  disabledText: string;
  unavailableText: string;
  envNames: readonly string[];
  extraNote?: string;
  /** Optional control rendered under a divider beneath the status (e.g. an on/off switch). */
  action?: ReactNode;
}) {
  const state = screenStateOf(props.status);
  return (
    <section aria-labelledby={props.headingId} className="rounded-xl border border-border bg-card-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-full border border-border bg-secondary-bg/40 px-2 py-0.5 text-xs font-medium',
                state === 'on' ? 'text-success-bg' : 'text-text-primary',
              )}
              role="status"
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  state === 'on' ? 'bg-success-bg' : state === 'off' ? 'bg-primary-button-bg' : 'bg-border',
                )}
              />
              {state === 'on' ? props.enabledText : state === 'off' ? props.disabledText : props.unavailableText}
            </span>
          </div>
          <h4 id={props.headingId} className="mt-2 text-sm font-medium text-text-primary">
            {props.title}
          </h4>
          <p className="mt-0.5 text-sm text-text-secondary">{props.description}</p>
        </div>
      </div>

      {state === 'on' ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-text-secondary">Threshold</dt>
          <dd className="text-text-primary">{props.status?.threshold ?? 'Default'}</dd>
          {props.status?.timeoutMs === undefined ? null : (
            <>
              <dt className="text-text-secondary">Timeout</dt>
              <dd className="text-text-primary">{props.status.timeoutMs} ms</dd>
            </>
          )}
        </dl>
      ) : state === 'unavailable' ? (
        <p className="mt-3 text-xs text-text-secondary">
          The server did not report this screen&apos;s status — it may be an older build, or the capabilities request
          has not finished. On or off cannot be confirmed here.
        </p>
      ) : null}

      <p className="mt-3 text-xs text-text-secondary">
        Server env:{' '}
        {props.envNames.map((name, index) => (
          <span key={name}>
            {index === 0 ? null : ', '}
            <code>{name}</code>
          </span>
        ))}
        {props.extraNote === undefined ? null : `. ${props.extraNote}`}
      </p>

      {props.action === undefined ? null : <div className="mt-4 border-t border-border pt-4">{props.action}</div>}
    </section>
  );
}

function ToolOutputScreenToggle(props: { status: TrueForgeApi.ToolOutputScreenCapability | null }) {
  const setting = useToolOutputScreenSetting();
  const toaster = useToasterOptional();
  if (!setting.supported) return null;

  const { status } = props;
  const configured = status?.configured ?? true;
  const reason = status?.reason;
  const checked = setting.enabled ?? false;
  const disabled = setting.saving || setting.enabled === null || !configured;
  /**
   * The reset link stays usable while unconfigured: clearing a stale override is the only
   * recourse then, and the backend keeps `PUT {"enabled": null}` allowed so a stale override
   * is always removable. It stays disabled while there is no stored override to clear.
   */
  const resetDisabled = setting.saving || setting.enabled === null || setting.overridden !== true;
  const defaultLabel =
    setting.defaultEnabled === null
      ? 'the server default'
      : `the server default (${setting.defaultEnabled ? 'on' : 'off'})`;
  /**
   * Honest copy while unconfigured: the stored setting is inert (screening is off because no
   * screening service is configured), so the override/following copy would both be false there.
   */
  const stateCopy = !configured
    ? 'Screening is off because no screening service is configured for this server.'
    : setting.overridden === true
      ? 'This switch overrides the server default.'
      : `Following ${defaultLabel}; flipping the switch stores an override for this server.`;
  const reasonId = 'tool-output-screen-reason';
  const showReason = !configured && reason !== undefined;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor="tool-output-screen-toggle" className="text-sm font-medium text-text-primary">
          Screen live tool output with Prompt Guard
        </label>
        <p className="mt-0.5 text-xs text-text-secondary">{stateCopy}</p>
        {showReason ? (
          <p id={reasonId} className="mt-1 text-xs text-text-secondary">
            {reason}
          </p>
        ) : null}
        {setting.overridden === true ? (
          <button
            type="button"
            className="mt-1.5 text-xs font-medium text-text-secondary underline underline-offset-2 hover:text-text-primary disabled:opacity-50"
            disabled={resetDisabled}
            onClick={() => {
              void setting.clearOverride().then(
                () => toaster?.showSuccess({ title: 'Tool-output screen reset to server default' }),
                () => {},
              );
            }}
          >
            Reset to server default
          </button>
        ) : null}
        {setting.error === null ? null : (
          <p className="mt-1.5 text-xs text-danger" role="alert">
            {setting.error}
          </p>
        )}
      </div>
      <Switch
        id="tool-output-screen-toggle"
        checked={checked}
        disabled={disabled}
        onCheckedChange={next => {
          void setting.setEnabled(next).then(
            () =>
              toaster?.showSuccess({ title: next ? 'Tool-output screening is on' : 'Tool-output screening is off' }),
            () => {},
          );
        }}
        aria-label="Screen live tool output with Prompt Guard"
        aria-describedby={showReason ? reasonId : undefined}
      />
    </div>
  );
}

function MemoryScreenToggle(props: { status: TrueForgeApi.MemoryScreenCapability | null }) {
  const setting = useMemoryScreenSetting();
  const toaster = useToasterOptional();
  if (!setting.supported) return null;

  const { status } = props;
  const configured = status?.configured ?? true;
  const reason = status?.reason;
  const checked = setting.enabled ?? false;
  const disabled = setting.saving || setting.enabled === null || !configured;
  /**
   * The reset link stays usable while unconfigured: clearing a stale override is the only
   * recourse then, and the backend keeps `PUT {"enabled": null}` allowed so a stale override
   * is always removable. It stays disabled while there is no stored override to clear.
   */
  const resetDisabled = setting.saving || setting.enabled === null || setting.overridden !== true;
  const defaultLabel =
    setting.defaultEnabled === null
      ? 'the server default'
      : `the server default (${setting.defaultEnabled ? 'on' : 'off'})`;
  /**
   * Honest copy while unconfigured: the stored setting is inert (screening is off because no
   * screening service is configured), so the override/following copy would both be false there.
   */
  const stateCopy = !configured
    ? 'Recall screening is off because no screening service is configured for this server.'
    : setting.overridden === true
      ? 'This switch overrides the server default.'
      : `Following ${defaultLabel}; flipping the switch stores an override for this server.`;
  const reasonId = 'memory-screen-reason';
  const showReason = !configured && reason !== undefined;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor="memory-screen-toggle" className="text-sm font-medium text-text-primary">
          Screen recalled memories with Prompt Guard
        </label>
        <p className="mt-0.5 text-xs text-text-secondary">{stateCopy}</p>
        {showReason ? (
          <p id={reasonId} className="mt-1 text-xs text-text-secondary">
            {reason}
          </p>
        ) : null}
        {setting.overridden === true ? (
          <button
            type="button"
            className="mt-1.5 text-xs font-medium text-text-secondary underline underline-offset-2 hover:text-text-primary disabled:opacity-50"
            disabled={resetDisabled}
            onClick={() => {
              void setting.clearOverride().then(
                () => toaster?.showSuccess({ title: 'Recall screening reset to server default' }),
                () => {},
              );
            }}
          >
            Reset to server default
          </button>
        ) : null}
        {setting.error === null ? null : (
          <p className="mt-1.5 text-xs text-danger" role="alert">
            {setting.error}
          </p>
        )}
      </div>
      <Switch
        id="memory-screen-toggle"
        checked={checked}
        disabled={disabled}
        onCheckedChange={next => {
          void setting.setEnabled(next).then(
            () => toaster?.showSuccess({ title: next ? 'Recall screening is on' : 'Recall screening is off' }),
            () => {},
          );
        }}
        aria-label="Screen recalled memories with Prompt Guard"
        aria-describedby={showReason ? reasonId : undefined}
      />
    </div>
  );
}

function MemorySummarizeToggle({ setting }: { setting: MemorySummarizeSettingState }) {
  const toaster = useToasterOptional();

  // The switch shows the effective state — what the server will actually do — never
  // the stored wish. On the markdown backend the two are the same; on any other
  // backend the gate blocks and the switch stays off and disabled.
  const blocked = setting.enabled === true && setting.effectiveEnabled === false;
  const checked = setting.effectiveEnabled ?? false;
  const disabled = setting.saving || setting.effectiveEnabled === null || blocked;
  /**
   * The reset link stays disabled while there is no stored override to clear; unlike
   * screening there is no unconfigured state that neuters the stored value, so the
   * switch always reflects the stored setting. Hidden entirely while the backend
   * gate blocks, where a stored override changes nothing.
   */
  const showReset = setting.overridden === true && !blocked;
  const resetDisabled = setting.saving || setting.enabled === null;
  const defaultLabel =
    setting.defaultEnabled === null
      ? 'the server default'
      : `the server default (${setting.defaultEnabled ? 'on' : 'off'})`;
  const stateCopy =
    setting.overridden === true
      ? 'This switch overrides the server default.'
      : `Following ${defaultLabel}; flipping the switch stores an override for this server.`;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor="memory-summarize-toggle" className="text-sm font-medium text-text-primary">
          Summarize turns before saving
        </label>
        {blocked ? (
          <p className="mt-0.5 text-xs text-text-secondary">
            Turn summaries need Markdown memory. This server&rsquo;s memory setup saves the full transcript, so the
            switch stays off.
          </p>
        ) : (
          <p className="mt-0.5 text-xs text-text-secondary">{stateCopy}</p>
        )}
        {showReset ? (
          <button
            type="button"
            className="mt-1.5 text-xs font-medium text-text-secondary underline underline-offset-2 hover:text-text-primary disabled:opacity-50"
            disabled={resetDisabled}
            onClick={() => {
              void setting.clearOverride().then(
                () => toaster?.showSuccess({ title: 'Turn summaries reset to server default' }),
                () => {},
              );
            }}
          >
            Reset to server default
          </button>
        ) : null}
        {setting.error === null ? null : (
          <p className="mt-1.5 text-xs text-danger" role="alert">
            {setting.error}
          </p>
        )}
      </div>
      <Switch
        id="memory-summarize-toggle"
        checked={checked}
        disabled={disabled}
        onCheckedChange={next => {
          void setting.setEnabled(next).then(
            () => toaster?.showSuccess({ title: next ? 'Turn summaries are on' : 'Turn summaries are off' }),
            () => {},
          );
        }}
        aria-label="Summarize turns before saving"
      />
    </div>
  );
}

/** Turn-summarization switch: on saves a short summary per turn, off keeps the full transcript. */
function MemorySummarizeCard() {
  const assistant = useAssistantDisplayName();
  const setting = useMemorySummarizeSetting();
  // The whole card hides when the server has no summarization port: no heading,
  // no empty bordered box, nothing to confuse the eye.
  if (!setting.supported) return null;
  return (
    <section aria-labelledby="memory-summarize-heading" className="rounded-xl border border-border bg-card-bg p-4">
      <h4 id="memory-summarize-heading" className="text-sm font-medium text-text-primary">
        Turn summaries
      </h4>
      <p className="mt-1 text-sm text-text-secondary">
        When this is on, {assistant} saves only the lasting facts from each finished chat, such as who people are,
        plans, preferences, and anything you ask it to remember. It does not save the chat itself or small talk. If a
        turn has no lasting facts, or a summary can&rsquo;t be made, nothing is saved for that turn. When this is off,{' '}
        {assistant} saves each turn word for word.
      </p>
      <div className="mt-4 border-t border-border pt-4">
        <MemorySummarizeToggle setting={setting} />
      </div>
    </section>
  );
}

const MEMORY_NOTES_MARKDOWN = [
  'The host recalls relevant memories before every model call and retains each finished turn on its own.',
  'Memories are local Markdown files on the server, namespaced per tenant, managed entirely by the host.',
  'Saving happens on the host automatically as part of each finished turn.',
  'Every recalled block is visible byte-for-byte in that turn\u2019s events as aman.memory.recall.',
];

/** The memory backend the server confirmed, or undefined while loading / when unknown. */
type ConfirmedBackend = ReturnType<typeof readMemoryBackend>;

/** Header tagline: Markdown-native wording only once the Markdown backend is confirmed. */
function headerCopy({
  settled,
  backend,
  assistant,
}: {
  settled: boolean;
  backend: ConfirmedBackend;
  assistant: string;
}): string {
  if (!settled) {
    return `${assistant} remembers what matters on its own. Checking with the server how memories are kept.`;
  }
  if (backend === 'markdown') {
    return `${assistant} saves memories as notes on this computer and brings back the ones that matter on its own.`;
  }
  if (backend === 'hindsight') {
    return `${assistant} remembers what matters on its own. This setup uses the experimental Hindsight memory instead of note files.`;
  }
  return `${assistant} remembers what matters on its own. It could not tell which kind of memory this setup uses, so the details below may not match.`;
}

/** The status pill tones: green dot for a confirmed-on backend, neutral otherwise. */
function StatusPill({ tone, text }: { tone: 'on' | 'neutral'; text: string }) {
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 rounded-full border border-border bg-secondary-bg/40 px-2 py-0.5 text-xs font-medium',
        tone === 'on' ? 'text-success-bg' : 'text-text-primary',
      )}
      role="status"
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', tone === 'on' ? 'bg-success-bg' : 'bg-border')} />
      {text}
    </span>
  );
}

/** The recall switch: off stops saved memories from shaping replies; the memories themselves stay. */
function MemoryRecallToggle() {
  const assistant = useAssistantDisplayName();
  const { agentSpec } = useTrueFoundryAgentSpec();
  const setting = useMemoryRecallSetting();

  // The server's person-level switch owns the choice; the agent's own value only shows until it is set.
  const recallEnabled = setting.enabled ?? agentSpec?.config?.memory?.recallEnabled ?? true;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor="memory-recall-toggle" className="text-sm font-medium text-text-primary">
          Use memories in replies
        </label>
        <p className="mt-0.5 text-xs text-text-secondary">
          When this is off, {assistant} does not bring saved memories into its replies. Saved memories are kept.
        </p>
        {setting.enabled === null ? null : (
          <button
            type="button"
            className="mt-1 text-xs text-text-secondary underline"
            disabled={setting.saving}
            onClick={() => {
              void setting.clear().catch(() => undefined);
            }}
          >
            Follow each agent&apos;s own setting
          </button>
        )}
        {setting.error === null ? null : (
          <p role="alert" className="mt-1 text-xs text-text-secondary">
            {setting.error}
          </p>
        )}
      </div>
      <Switch
        id="memory-recall-toggle"
        checked={recallEnabled}
        disabled={!setting.supported || setting.saving}
        onCheckedChange={next => {
          // The failure message is shown below; the rejection carries nothing more to handle.
          void setting.setEnabled(next).catch(() => undefined);
        }}
        aria-label="Use memories in replies"
      />
    </div>
  );
}

/** Names the memory backend only after capabilities settle: checking while loading,
 * unavailable on a missing or malformed backend — never a guess. */
function MemoryStatusCard() {
  const capabilities = useServerCapabilities();
  const settled = useServerCapabilitiesSettled();
  const backend = readMemoryBackend(capabilities);

  const pill =
    !settled || backend === undefined ? (
      <StatusPill tone="neutral" text={!settled ? 'Checking memory status…' : 'Memory status unavailable'} />
    ) : (
      <StatusPill tone="on" text="Memory is on" />
    );
  const heading = !settled
    ? 'Memory'
    : backend === 'markdown'
      ? 'Markdown (local files)'
      : backend === 'hindsight'
        ? 'Hindsight (experimental)'
        : 'Memory';
  const body = !settled
    ? 'Asking the server which memory backend is running — this takes a moment.'
    : backend === 'markdown'
      ? 'The host recalls relevant memories before every reply and saves each finished exchange automatically.'
      : backend === 'hindsight'
        ? 'This server runs the experimental Hindsight memory backend. Markdown file memory — the storage line and explainer below — does not apply here.'
        : 'The server did not report which memory backend is running — on or off cannot be confirmed here.';

  return (
    <section aria-labelledby="memory-status-heading" className="rounded-xl border border-border bg-card-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">{pill}</div>
          <h4 id="memory-status-heading" className="mt-2 truncate text-sm font-medium text-text-primary">
            {heading}
          </h4>
          <p className="mt-0.5 text-sm text-text-secondary">{body}</p>
        </div>
      </div>

      {settled && backend === 'markdown' ? <MemoryStorageLine /> : null}

      {settled && backend !== undefined ? (
        <div className="mt-4 border-t border-border pt-4">
          <MemoryRecallToggle />
        </div>
      ) : null}
    </section>
  );
}

/** Settings > Memory: the host's memory surface, honest about which backend is running.
 *
 * The backend is named only once the capabilities confirm it — "Checking memory status…"
 * while loading, "Memory status unavailable" when the settled capability is malformed or
 * missing. The storage line, "How memory works", and the header tagline are Markdown-native
 * and render only on a confirmed Markdown backend.
 */
const MemorySettings = () => {
  const assistant = useAssistantDisplayName();
  const capabilities = useServerCapabilities();
  const settled = useServerCapabilitiesSettled();
  const backend = readMemoryBackend(capabilities);
  const toolOutputScreen = readToolOutputScreenStatus(capabilities);
  const memoryScreen = readMemoryScreenStatus(capabilities);
  const confirmedMarkdown = settled && backend === 'markdown';

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto pb-1">
      <header>
        <h3 className="text-base font-semibold text-text-primary">Memory</h3>
        <p className="mt-1 text-sm text-text-secondary">{headerCopy({ settled, backend, assistant })}</p>
      </header>

      <MemoryStatusCard />

      <MemorySummarizeCard />

      <MemoryEmbeddingsCard />

      <div className="grid gap-3 lg:grid-cols-2">
        <ScreenStatusCard
          headingId="memory-screen-status-heading"
          title="Recall screening"
          description={`The recall checker runs against memories ${assistant} recalls for itself, on this tenant only.`}
          status={memoryScreen}
          enabledText="Recall screening is on"
          disabledText="Recall screening is off"
          unavailableText="Recall screening status unavailable"
          envNames={[
            'MEMORY_SCREEN_ENABLED',
            'MEMORY_SCREEN_URL',
            'MEMORY_SCREEN_AUTH_TOKEN',
            'MEMORY_SCREEN_THRESHOLD',
          ]}
          action={<MemoryScreenToggle status={memoryScreen} />}
        />
        <ScreenStatusCard
          headingId="tool-output-screen-status-heading"
          title="Tool-output screening"
          description="The tool-output checker runs on MCP and skill tool results and attachments on this tenant."
          status={toolOutputScreen}
          enabledText="Tool-output screening is on"
          disabledText="Tool-output screening is off"
          unavailableText="Tool-output screening status unavailable"
          envNames={[
            'TOOL_OUTPUT_SCREEN_ENABLED',
            'TOOL_OUTPUT_SCREEN_TIMEOUT_MS',
            'MEMORY_SCREEN_URL',
            'MEMORY_SCREEN_AUTH_TOKEN',
            'MEMORY_SCREEN_THRESHOLD',
          ]}
          action={<ToolOutputScreenToggle status={toolOutputScreen} />}
        />
      </div>

      {confirmedMarkdown ? (
        <section aria-labelledby="memory-notes-heading" className="rounded-xl border border-border bg-card-bg p-4">
          <h5 id="memory-notes-heading" className="text-sm font-medium text-text-primary">
            How memory works
          </h5>
          <ul className="mt-2 space-y-2 text-sm text-text-secondary">
            {MEMORY_NOTES_MARKDOWN.map(note => (
              <li key={note} className="flex gap-2">
                <span aria-hidden="true" className="mt-0.5 shrink-0 text-text-tertiary">
                  •
                </span>
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
};

export default MemorySettings;

/** Where this host keeps its Markdown memories, read from the server — display only.
 *
 * The directory is server truth (`MEMORY_MARKDOWN_DIR` as the process resolved it), never
 * user-editable here. When the server does not report it (older build), the line says so
 * instead of showing a wrong path.
 */
function MemoryStorageLine() {
  const capabilities = useServerCapabilities();
  const dir = readMemoryStorageDir(capabilities);
  return (
    <p className="mt-3 text-xs text-text-secondary">
      {dir === null ? (
        'The server did not report where memories are stored.'
      ) : (
        <>
          Memories live in <code className="break-all text-text-primary">{dir}</code> on this server.
        </>
      )}
    </p>
  );
}

/** Live meaning-based recall status: downloading → indexing → ready, or keyword fallback. */
function MemoryEmbeddingsCard() {
  const assistant = useAssistantDisplayName();
  const capabilities = useServerCapabilities();
  const refreshCapabilities = useOptionalRefreshServerCapabilities();
  const status = readMemoryEmbeddingsStatus(capabilities);
  const failed = status !== null && status.enabled && status.state === 'unavailable';
  // The failure notice shows once per failure episode: dismissing hides it, and it
  // re-arms only if smart search recovers and fails again — never a nag on every poll.
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  useEffect(() => {
    if (!failed) {
      setNoticeDismissed(false);
    }
  }, [failed]);
  const transitional =
    status !== null &&
    status.enabled &&
    (status.state === 'starting' ||
      status.state === 'downloading' ||
      status.state === 'backfilling' ||
      status.state === 'unavailable');
  useEffect(() => {
    if (!transitional || refreshCapabilities === null) return;
    const timer = setInterval(refreshCapabilities, 5000);
    return () => clearInterval(timer);
  }, [transitional, refreshCapabilities]);
  return (
    <section aria-labelledby="memory-search-heading" className="rounded-xl border border-border bg-card-bg p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 id="memory-search-heading" className="text-sm font-medium text-text-primary">
          How {assistant} finds memories
        </h4>
        <EmbeddingsBadge status={status} />
      </div>
      {failed && !noticeDismissed ? (
        <div role="alert" className="mt-3 rounded-lg border border-warning-bg/40 bg-warning-bg/10 p-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm text-text-primary">
              <span className="font-medium">Smart search isn&rsquo;t available right now.</span> Aman couldn&rsquo;t
              load its meaning-based search helper, so memories are found with keywords for now. It&rsquo;s trying again
              automatically — there&rsquo;s nothing you need to do.
            </p>
            <button
              type="button"
              className="shrink-0 text-xs font-medium text-text-secondary underline underline-offset-2 hover:text-text-primary"
              onClick={() => setNoticeDismissed(true)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
      <p className="mt-1 text-sm text-text-secondary">
        {status?.detail ??
          'The server did not report meaning-based recall status — it may be an older build, or the capabilities request has not finished.'}
      </p>
      <p className="mt-2 text-sm text-text-secondary">
        {assistant} finds memories by meaning, not just matching words. So &ldquo;where did we stay on that trip&rdquo;
        finds the hotel note even when it only names the hotel. To do that, the first time {assistant} runs it downloads
        a small helper model once (about 120&nbsp;MB), automatically in the background. There is nothing to install and
        nothing to click. After that one download, memory search works fully offline, and everything stays on this
        server. If the download can&rsquo;t finish, {assistant} just keeps finding memories with keywords.
      </p>
    </section>
  );
}

function EmbeddingsBadge({ status }: { status: MemoryEmbeddingsStatus | null }) {
  const label =
    status === null
      ? 'Status unavailable'
      : !status.enabled
        ? 'Keywords only'
        : status.state === 'ready'
          ? 'Ready'
          : status.state === 'downloading'
            ? 'Downloading'
            : status.state === 'backfilling'
              ? 'Indexing'
              : status.state === 'starting'
                ? 'Starting'
                : 'Keywords only';
  const tone =
    status !== null && status.enabled && status.state === 'ready'
      ? 'text-success-bg'
      : status !== null &&
          status.enabled &&
          (status.state === 'starting' || status.state === 'downloading' || status.state === 'backfilling')
        ? 'text-primary-button-bg'
        : status !== null && status.enabled && status.state === 'unavailable'
          ? 'text-warning-bg'
          : 'text-text-primary';
  const dot =
    status !== null && status.enabled && status.state === 'ready'
      ? 'bg-success-bg'
      : status !== null &&
          status.enabled &&
          (status.state === 'starting' || status.state === 'downloading' || status.state === 'backfilling')
        ? 'bg-primary-button-bg'
        : status !== null && status.enabled && status.state === 'unavailable'
          ? 'bg-warning-bg'
          : 'bg-border';
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 rounded-full border border-border bg-secondary-bg/40 px-2 py-0.5 text-xs font-medium',
        tone,
      )}
      role="status"
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      {label}
    </span>
  );
}
