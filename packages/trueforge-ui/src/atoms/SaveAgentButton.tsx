'use client';

import {
  useTrueFoundryAdoptAgentSpec,
  useTrueFoundryAgentSpec,
  useTrueFoundryFlushAgentSpec,
} from '@truefoundry/assistant-ui-runtime';
import { useEffect, useRef, useState } from 'react';
import { useSaveAgentVisible } from '../hooks/useChatChromeActionsVisible.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalServer } from '../server/ServerContext.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import type { AgentSpec } from '../server/types.js';
import { getErrorMessage } from '../utils/getErrorMessage.js';
import { useOptionalAgentConfigInstructions } from './draft/AgentConfigInstructionsContext.js';
import { agentNameFromLabel } from './lib/agentName.js';
import { auiButtonClass } from './lib/buttonClasses.js';
import { auiInputClass } from './lib/inputClasses.js';
import { CenteredModal } from './primitives/CenteredModal.js';
import { Tooltip } from './primitives/Tooltip.js';

type SaveIntent = 'create' | 'update';
export type SaveAgentButtonProps = {
  disabled?: boolean;
  className?: string;
  children?: string;
};

export function SaveAgentButton({ disabled = false, className, children = 'Save Agent' }: SaveAgentButtonProps) {
  return (
    <SaveAgentButtonContent disabled={disabled} className={className}>
      {children}
    </SaveAgentButtonContent>
  );
}

function SaveAgentButtonContent({
  disabled,
  className,
  children,
}: {
  disabled: boolean;
  className?: string;
  children: string;
}) {
  const { agentSpec, draftSessionId } = useTrueFoundryAgentSpec();
  const agentSpecRef = useRef(agentSpec);
  agentSpecRef.current = agentSpec;
  const flushAgentSpec = useTrueFoundryFlushAgentSpec();
  const adoptAgentSpec = useTrueFoundryAdoptAgentSpec();
  const builder = useOptionalServer();
  const shell = useOptionalShellMode();
  const instructionsDraft = useOptionalAgentConfigInstructions();
  const visible = useSaveAgentVisible();
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<SaveIntent>('create');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [draftSpec, setDraftSpec] = useState<AgentSpec | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const savedName = intent === 'create' ? agentNameFromLabel(name) : name.trim();

  useEffect(() => {
    if (error === null) return;
    // scrollIntoView is unimplemented in jsdom; guard so tests don't throw.
    errorRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [error]);

  const close = () => {
    if (saving) return;
    setOpen(false);
    setDraftSpec(null);
    setDescription('');
    setError(null);
  };

  const show = async () => {
    if (agentSpecRef.current === null || builder === null) return;
    setError(null);
    instructionsDraft?.flush();
    await flushAgentSpec();
    const latestAgentSpec = agentSpecRef.current;
    if (latestAgentSpec === null) return;
    const currentName = shell?.mode.status === 'active' ? (shell.mode.agentName ?? shell.mode.agentId ?? '') : '';
    const currentDescription = shell?.mode.status === 'active' ? (shell.mode.description ?? '') : '';
    setIntent(currentName ? 'update' : 'create');
    setName(currentName);
    setDescription(currentDescription);
    setDraftSpec({
      ...latestAgentSpec,
      // The debounced instructions draft may not have reached `agentSpec` yet even after
      // `flush()` (its commit is async in the real runtime); read the pending value directly
      // so Save never drops keystrokes typed just before opening this dialog.
      instructions: instructionsDraft?.draft ?? latestAgentSpec.instructions,
      model: {
        ...latestAgentSpec.model,
        params: latestAgentSpec.model.params ? { ...latestAgentSpec.model.params } : undefined,
      },
      mcpServers: latestAgentSpec.mcpServers?.map(item => ({ ...item })),
      skills: latestAgentSpec.skills?.map(item => ({ ...item })),
      config: latestAgentSpec.config ? { ...latestAgentSpec.config } : undefined,
    });
    setOpen(true);
  };

  const save = async () => {
    if (builder === null || draftSpec === null) return;
    // An existing agent keeps its saved name; a new one takes the tidied form of what was typed.
    const normalizedName = intent === 'create' ? agentNameFromLabel(name) : name.trim();
    const normalizedDescription = description.trim();
    if (!normalizedName || !normalizedDescription || !draftSpec.model.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const result = await builder.saveAgent({
        agentName: normalizedName,
        description: normalizedDescription,
        agentSpec: draftSpec,
        intent,
        sessionId: draftSessionId,
      });
      adoptAgentSpec({ agentSpec: draftSpec, updatedAt: result.sessionUpdatedAt });
      shell?.bindMutableAgent({
        agentId: result.agentId ?? normalizedName,
        agentName: normalizedName,
        agentSpec: draftSpec,
      });
      shell?.invalidateAgentsList();
      setOpen(false);
      setDraftSpec(null);
    } catch (caught) {
      setError(getErrorMessage(caught, 'Could not save agent'));
    } finally {
      setSaving(false);
    }
  };

  const isUpdateMode =
    shell?.mode.status === 'active' &&
    shell.mode.isMutable &&
    (shell.mode.agentName !== undefined || shell.mode.agentId !== undefined);
  const triggerLabel = isUpdateMode && children === 'Save Agent' ? 'Update Agent' : children;

  if (!visible) return null;

  const triggerTooltip =
    intent === 'update' || (isUpdateMode && children === 'Save Agent')
      ? 'Save your changes to this agent.'
      : 'Save this setup as an agent you can use again.';

  return (
    <>
      {/* Below the button and wrapped: the header sits at the top of the screen, so a tooltip above it
          would be pushed back down over the button it describes. */}
      <Tooltip side="bottom" className="w-60 whitespace-normal leading-snug" content={triggerTooltip}>
        <button
          type="button"
          disabled={disabled || builder === null || agentSpec === null}
          className={auiButtonClass({ variant: 'primary', size: 'small', className })}
          onClick={() => void show()}
        >
          <Icon name="save" className="size-3.5" />
          {triggerLabel}
        </button>
      </Tooltip>

      <CenteredModal
        open={open}
        onOpenChange={next => !next && close()}
        title={intent === 'create' ? 'Save agent' : 'Update agent'}
        className="md:ml-auto md:mr-0 md:h-dvh md:max-h-[85dvh] md:max-w-2xl"
        aria-label={intent === 'create' ? 'Save agent' : 'Update agent'}
      >
        {draftSpec ? (
          <div className="flex min-h-0 w-full flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
              <label className="mb-3 block">
                <span className="mb-1.5 block text-sm font-medium">Name</span>
                <input
                  value={name}
                  disabled={saving || intent === 'update'}
                  onChange={event => setName(event.target.value)}
                  placeholder="Morning email helper"
                  className={auiInputClass('h-9 disabled:opacity-60')}
                />
                {intent === 'create' && savedName !== '' && savedName !== name.trim() ? (
                  <span className="text-text-secondary mt-1 block text-xs">It will be saved as {savedName}.</span>
                ) : null}
                {intent === 'create' && savedName === '' && name.trim() !== '' ? (
                  <span role="alert" className="text-failure-bg mt-1 block text-xs">
                    Use at least one letter from a to z in the name.
                  </span>
                ) : null}
              </label>

              <label className="mb-3 block">
                <span className="mb-1.5 block text-sm font-medium">What it's for</span>
                <textarea
                  value={description}
                  disabled={saving}
                  onChange={event => setDescription(event.target.value)}
                  rows={2}
                  placeholder="Reads my email each morning and lists what needs a reply."
                  className={auiInputClass('resize-y py-2 disabled:opacity-60')}
                />
              </label>

              <p className="text-text-secondary text-sm">
                It saves the setup you made: what it should do, its connectors and skills, and anything under More
                settings.
              </p>

              {error ? (
                <p
                  ref={errorRef}
                  role="alert"
                  className="text-failure-bg mt-3 text-sm wrap-break-word whitespace-pre-wrap tab-4"
                >
                  {error}
                </p>
              ) : null}
            </div>

            <div className="bg-card-bg sticky bottom-0 z-10 flex shrink-0 justify-end gap-2 border-t border-border px-5 py-4">
              <button
                type="button"
                disabled={saving}
                className={auiButtonClass({ variant: 'secondary' })}
                onClick={close}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving || savedName === '' || !description.trim() || !draftSpec.model.name.trim()}
                className={auiButtonClass({ variant: 'primary' })}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : intent === 'create' ? 'Save agent' : 'Save changes'}
              </button>
            </div>
          </div>
        ) : null}
      </CenteredModal>
    </>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    SaveAgentButton: typeof SaveAgentButton;
  }
}
