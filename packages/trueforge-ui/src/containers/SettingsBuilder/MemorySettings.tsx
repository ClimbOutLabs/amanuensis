'use client';

import { useState, type ReactNode } from 'react';

import { cn } from '@/atoms/lib/cn.js';
import { Switch } from '@/atoms/primitives/Switch.js';
import { useServerCapabilities } from '@/server/ServerContext.js';
import { readMemoryDefaults } from './memoryDefaultsCapability.js';
import {
  readMemoryScreenStatus,
  readToolOutputScreenStatus,
  type ToolOutputScreenStatus,
} from './memoryScreenCapability.js';
import MemoryTuningForm, { draftFromSettings, type MemoryTuningDraft } from './MemoryTuningForm.js';
import { useToolOutputScreenSetting } from './toolOutputScreenSetting.js';
import { useToasterOptional } from '../ToasterContainer.js';

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

function ToolOutputScreenToggle(props: { status: ToolOutputScreenStatus | null }) {
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
          <p className="mt-1.5 text-xs text-red-600" role="alert">
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

const MEMORY_NOTES_MARKDOWN = [
  'The host recalls relevant memories before every model call and retains each finished turn on its own \u2014 memory is not a tool the model chooses to call.',
  'There is no bank to connect: memories are local Markdown files on the server, namespaced per tenant, managed entirely by the host.',
  'The model gets no memory write tools \u2014 saving already happened on the host, so there is nothing to duplicate and no approval prompt for it.',
  'Every recalled block is visible byte-for-byte in that turn\u2019s events as aman.memory.recall \u2014 nothing reaches the model invisibly.',
];

/** Settings > Memory when the host runs local Markdown memory (or the experimental fallback).
 *
 * Markdown is the supported memory implementation: the host recalls relevant memories before
 * every model call and saves each finished turn to local Markdown files on its own, with no bank
 * to connect, no credentials, and no per-bank lifecycle to manage. The screen section keeps the
 * honest controls: recall screening (read-only here, resolved by the server) and the live
 * tool-output screening toggle (persisted per tenant). The tuning form is read-only —
 * Markdown memory is tuned through the server’s `MEMORY_*` environment, not per-bank
 * settings. Hindsight remains available only as an experimental server-side backend
 * (`MEMORY_BACKEND=hindsight`) and has no UI in Settings.
 */
const MemorySettings = () => {
  const capabilities = useServerCapabilities();
  const toolOutputScreen = readToolOutputScreenStatus(capabilities);
  const memoryDefaults = readMemoryDefaults(capabilities);
  const memoryScreen = readMemoryScreenStatus(capabilities);

  // The server defaults to markdown; the experimental hindsight backend stays server-only
  // and is never given a bank-management UI.
  const backend = memoryDefaults?.backend ?? 'markdown';
  const isMarkdown = backend === 'markdown';

  const [tuning, setTuning] = useState<MemoryTuningDraft>(() => draftFromSettings(undefined));

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto pb-1">
      <header>
        <h3 className="text-base font-semibold text-text-primary">Memory</h3>
        <p className="mt-1 text-sm text-text-secondary">
          Aman remembers what matters on its own. It recalls relevant memories before every reply
          and saves each finished exchange to local Markdown files — memory is not a tool
          the model chooses to call.
        </p>
      </header>

      <section
        aria-labelledby="memory-status-heading"
        className="rounded-xl border border-border bg-card-bg p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'flex items-center gap-1.5 rounded-full border border-border bg-secondary-bg/40 px-2 py-0.5 text-xs font-medium',
                  isMarkdown ? 'text-success-bg' : 'text-warning-bg',
                )}
                role="status"
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    isMarkdown ? 'bg-success-bg' : 'bg-warning-bg',
                  )}
                />
                {isMarkdown ? 'Memory is on' : 'Experimental backend'}
              </span>
            </div>
            <h4
              id="memory-status-heading"
              className="mt-2 truncate text-sm font-medium text-text-primary"
            >
              {isMarkdown ? 'Markdown (local files)' : 'Hindsight (experimental)'}
            </h4>
            <p className="mt-0.5 text-sm text-text-secondary">
              {isMarkdown
                ? 'Aman saves memories as local Markdown files on the server and recalls them before every reply. There is no bank to connect.'
                : 'The server is running the experimental Hindsight backend. Bank management is not available in Settings.'}
            </p>
          </div>
        </div>

        {isMarkdown ? (
          <MemoryTuningForm
            draft={tuning}
            busy={false}
            error={null}
            defaults={memoryDefaults}
            onChange={setTuning}
            onSave={() => {}}
            readOnly
          />
        ) : null}
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <ScreenStatusCard
          headingId="memory-screen-status-heading"
          title="Recall screening"
          description="The recall checker runs against memories Aman recalls for itself, on this tenant only."
          status={memoryScreen}
          enabledText="Recall screening is on"
          disabledText="Recall screening is off"
          unavailableText="Recall screening status unavailable"
          envNames={['MEMORY_SCREEN_ENABLED', 'MEMORY_SCREEN_URL', 'MEMORY_SCREEN_AUTH_TOKEN', 'MEMORY_SCREEN_THRESHOLD']}
          extraNote="The server resolves this from its environment — there is no per-bank switch."
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

      <section
        aria-labelledby="memory-notes-heading"
        className="rounded-xl border border-border bg-card-bg p-4"
      >
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
    </div>
  );
};

export default MemorySettings;
