'use client';

import { useEffect, useMemo, useState } from 'react';

import type { ScheduleTools } from '../../plugins/trueforge-agent-server-adapter/catalogs/scheduleToolsCatalog.js';
import { scheduleToolsErrorMessage } from '../../plugins/trueforge-agent-server-adapter/catalogs/scheduleToolsCatalog.js';
import { useServerCapabilities } from '../../server/ServerContext.js';
import type { AgentSkill, ConnectorState } from '../../server/types.js';
import { DraftToolPicker, type DraftMount } from '../draft/DraftToolPicker.js';
import { skillFamilyId } from '../draft/SkillVersionSelector.js';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/Button.js';
import { useScheduleToolsPort } from './useScheduleToolsPort.js';

type ToolsTab = 'connectors' | 'skills';

const TABS: { id: ToolsTab; label: string }[] = [
  { id: 'connectors', label: 'Connectors' },
  { id: 'skills', label: 'Skills' },
];

export type ScheduleToolsSectionProps = {
  scheduleId: string;
  /** Who it runs as, in the words the form shows. */
  runsAs: string;
  /** Opens the saved agent that holds the tools, when the schedule runs as one. */
  onOpenAgent?: () => void;
};

type Draft = { connectors: DraftMount[]; skills: DraftMount[]; sandboxEnabled: boolean };

function draftOf(tools: ScheduleTools): Draft {
  return {
    connectors: tools.connectors.map(name => ({ id: name, name })),
    skills: tools.skills.map(name => ({ id: name, name })),
    sandboxEnabled: tools.sandboxEnabled,
  };
}

function names(mounts: readonly DraftMount[]): string[] {
  return mounts.map(mount => mount.name);
}

function ReadOnlyTools({ tools }: { tools: ScheduleTools }) {
  const rows: [string, string][] = [
    ['Connectors', tools.connectors.length > 0 ? tools.connectors.join(', ') : 'None'],
    ['Skills', tools.skills.length > 0 ? tools.skills.join(', ') : 'None'],
    ['Sandbox', tools.sandboxEnabled ? 'On' : 'Off'],
  ];
  return (
    <dl className="rounded-lg border border-border text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0">
          <dt className="text-text-secondary">{label}</dt>
          <dd className="min-w-0 text-right">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What a saved schedule runs with: its connectors, skills and sandbox. A schedule with its own tools can change
 * them here. One that runs as a saved agent shows that agent's tools and says where to change them.
 */
export function ScheduleToolsSection({ scheduleId, runsAs, onOpenAgent }: ScheduleToolsSectionProps) {
  const port = useScheduleToolsPort();
  const capabilities = useServerCapabilities();
  const [tools, setTools] = useState<ScheduleTools | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<ToolsTab>('connectors');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (port === null) return;
    let cancelled = false;
    setTools(null);
    setDraft(null);
    setLoadError(null);
    port
      .getScheduleTools(scheduleId)
      .then(loaded => {
        if (cancelled) return;
        setTools(loaded);
        setDraft(draftOf(loaded));
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(scheduleToolsErrorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [port, scheduleId]);

  const changed = useMemo(() => {
    if (tools === null || draft === null) return false;
    const same = (left: readonly string[], right: readonly string[]) =>
      left.length === right.length && left.every(name => right.includes(name));
    return !(
      same(tools.connectors, names(draft.connectors)) &&
      same(tools.skills, names(draft.skills)) &&
      tools.sandboxEnabled === draft.sandboxEnabled
    );
  }, [tools, draft]);

  if (port === null) return null;

  const edit = (next: Draft) => {
    setDraft(next);
    setSaved(false);
    setSaveError(null);
  };

  const toggleConnector = (connector: ConnectorState) => {
    if (draft === null) return;
    edit({
      ...draft,
      connectors: draft.connectors.some(mount => mount.id === connector.id)
        ? draft.connectors.filter(mount => mount.id !== connector.id)
        : [...draft.connectors, { id: connector.id, name: connector.name }],
    });
  };

  const toggleSkill = (skill: AgentSkill) => {
    if (draft === null) return;
    const family = skillFamilyId(skill.id);
    const adding = !draft.skills.some(mount => skillFamilyId(mount.id) === family);
    edit({
      ...draft,
      skills: adding
        ? [...draft.skills, { id: skill.id, name: skill.name }]
        : draft.skills.filter(mount => skillFamilyId(mount.id) !== family),
      // Skills only work in the sandbox, so adding one turns it on where the server has one, as in a chat.
      sandboxEnabled: draft.sandboxEnabled || (adding && capabilities?.sandbox.enabled === true),
    });
  };

  const toggleSandbox = () => {
    if (draft === null) return;
    const next = !draft.sandboxEnabled;
    edit({ ...draft, sandboxEnabled: next, skills: next ? draft.skills : [] });
  };

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await port.setScheduleTools({
        scheduleId,
        tools: {
          connectors: names(draft.connectors),
          skills: names(draft.skills),
          sandboxEnabled: draft.sandboxEnabled,
        },
      });
      setTools(updated);
      setDraft(draftOf(updated));
      setSaved(true);
    } catch (caught) {
      setSaveError(scheduleToolsErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <fieldset aria-label="Tools" className="flex flex-col gap-2">
      <legend className="mb-1.5 text-sm font-medium">Tools</legend>
      {loadError !== null ? (
        <p role="alert" className="text-failure-bg text-sm">
          {loadError}
        </p>
      ) : tools === null || draft === null ? (
        <p className="text-text-secondary text-sm">Loading the tools…</p>
      ) : tools.source === 'saved_agent' ? (
        <>
          <p className="text-text-secondary text-sm">
            The tools of this schedule come from the agent {runsAs}. To change them, change that agent.
          </p>
          <ReadOnlyTools tools={tools} />
          {onOpenAgent === undefined ? null : (
            <div>
              <Button.Secondary type="button" size="small" onClick={onOpenAgent}>
                Open {runsAs}
              </Button.Secondary>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="text-text-secondary text-sm">
            The connectors, skills and sandbox this schedule runs with. Anything that needs your OK still waits for you,
            and nothing is sent without asking.
          </p>
          <div className="flex max-h-[22rem] min-h-[16rem] flex-col overflow-hidden rounded-lg border border-border">
            <div className="flex shrink-0 border-b border-border">
              {TABS.map(item => {
                const count = item.id === 'connectors' ? draft.connectors.length : draft.skills.length;
                const active = tab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    className={cn(
                      'text-text-secondary flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-medium',
                      active && 'text-primary-button-bg border-b-2 border-primary-button-bg',
                    )}
                    onClick={() => setTab(item.id)}
                  >
                    {item.label}
                    {count > 0 ? <span className="bg-secondary-bg rounded px-1 text-[0.625rem]">{count}</span> : null}
                  </button>
                );
              })}
            </div>
            <DraftToolPicker
              tab={tab}
              mcp={draft.connectors}
              skills={draft.skills}
              sandboxEnabled={draft.sandboxEnabled}
              onToggleConnector={toggleConnector}
              onToggleSkill={toggleSkill}
              onToggleSandbox={toggleSandbox}
            />
          </div>
          <div className="flex items-center justify-end gap-3">
            {saveError !== null ? (
              <p role="alert" className="text-failure-bg min-w-0 flex-1 text-sm">
                {saveError}
              </p>
            ) : saved ? (
              <p role="status" className="text-text-secondary min-w-0 flex-1 text-sm">
                Saved. The next run uses these tools.
              </p>
            ) : null}
            <Button.Secondary type="button" disabled={!changed || saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save tools'}
            </Button.Secondary>
          </div>
        </>
      )}
    </fieldset>
  );
}
