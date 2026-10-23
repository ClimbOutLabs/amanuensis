'use client';

import { ComposerPrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { useTrueFoundryAgentSpec, useTrueFoundryCancel } from '@truefoundry/assistant-ui-runtime';
import { useEffect, useRef, useState } from 'react';

import { CompactionStatusLine } from '../atoms/CompactionStatusLine.js';
import { DraftCatalogProvider } from '../atoms/draft/DraftCatalogProvider.js';
import { cn } from '../atoms/lib/cn.js';
import { useComposerBusyState } from '../hooks/useComposerBusyState.js';
import { takeComposerPrefill, useComposerDraft } from '../hooks/useComposerDraft.js';
import { useComposerPauseView } from '../hooks/useComposerPauseView.js';
import { useComposerPlaceholder } from '../hooks/useComposerPlaceholder.js';
import { useActiveSessionCanManage } from '../hooks/useResourcePermissions.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import { SlotsProvider, useSlot, useSlotIsDefault } from '../theme/SlotsProvider.js';
import { ApprovalNavContainer } from './ApprovalNavContainer.js';
import { AskUserContainer } from './AskUserContainer.js';
import { ComposerAttachmentsContainer } from './AttachmentsContainer.js';
import { CustomActionContainer } from './CustomActionContainer.js';
import { McpAuthContainer } from './McpAuthContainer.js';
import { useToasterOptional } from './ToasterContainer.js';

export type ComposerContainerProps = {
  placeholder?: string;
};

export function canSubmitComposer({
  disabled,
  hasText,
  hasAttachments,
  requiresModel,
  hasModel,
}: {
  disabled: boolean;
  hasText: boolean;
  hasAttachments: boolean;
  requiresModel: boolean;
  hasModel: boolean;
}): boolean {
  return !disabled && (hasText || hasAttachments) && (!requiresModel || hasModel);
}

function ComposerBody({
  placeholder,
  forceDisabled = false,
  connectedToBanner = false,
}: {
  placeholder: string;
  forceDisabled?: boolean;
  /** The approval strip sits flush above: drop the shared top corners and borders. */
  connectedToBanner?: boolean;
}) {
  const ComposerShell = useSlot('ComposerShell');
  const aui = useAui();
  const shell = useOptionalShellMode();
  const hasText = useAuiState(s => s.composer.text.trim().length > 0);
  const hasAttachments = useAuiState(s => s.composer.attachments.length > 0);
  const { agentSpec } = useTrueFoundryAgentSpec();
  // Named (immutable) agents use a server-side model; only draft/mutable composers pick one here.
  const requiresModel = shell == null || (shell.mode.status === 'active' && shell.mode.isMutable);
  const hasModel = Boolean(agentSpec?.model?.name?.trim());
  const { isBusy, send, resetBusy } = useComposerBusyState();
  useComposerDraft();
  useEffect(() => {
    const prefill = takeComposerPrefill();
    if (prefill !== null) aui.composer().setText(prefill);
  }, [aui]);
  const canManageSession = useActiveSessionCanManage();
  const cancel = useTrueFoundryCancel();
  // Shown from the press until the turn leaves the running state, which the runtime bounds.
  const [isStopping, setIsStopping] = useState(false);
  useEffect(() => {
    if (!isBusy) setIsStopping(false);
  }, [isBusy]);
  const toaster = useToasterOptional();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The box stays open during a run so the next message can be typed; only Send and Stop change.
  const inputDisabled = forceDisabled || !canManageSession;
  const disabled = isBusy || inputDisabled;
  const canSubmit = canSubmitComposer({ disabled, hasText, hasAttachments, requiresModel, hasModel });
  const submit = () => {
    if (!canSubmit) return;
    send(() => aui.composer().send());
  };
  const stop = canManageSession
    ? () => {
        setIsStopping(true);
        void (async () => {
          try {
            await cancel();
            resetBusy();
          } catch (error) {
            toaster?.showError(error);
          } finally {
            setIsStopping(false);
          }
        })();
      }
    : undefined;

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={event => {
          const files = event.target.files;
          if (files) {
            for (const file of files) {
              void aui.composer().addAttachment(file);
            }
          }
          event.target.value = '';
        }}
      />
      <ComposerPrimitive.AttachmentDropzone
        disabled={disabled}
        data-slot="aui_composer-attachment-dropzone"
        className="w-full rounded-[var(--composer-radius,1.5rem)] transition-[box-shadow] data-[dragging=true]:ring-focus-ring/20 data-[dragging=true]:ring-3"
      >
        <ComposerPrimitive.Root
          data-slot="aui_composer-root"
          className="w-full"
          onSubmit={event => {
            // Suppresses the primitive's own send so submits route through the busy-state wrapper.
            event.preventDefault();
            submit();
          }}
        >
          <ComposerShell
            attachments={<ComposerAttachmentsContainer />}
            input={
              <ComposerPrimitive.Input
                data-slot="aui_composer-input"
                placeholder={placeholder}
                disabled={inputDisabled}
                submitMode="enter"
                aria-label="Message input"
                onKeyDown={event => {
                  // Esc stops a running turn; the box is still typeable while it runs.
                  if (event.key !== 'Escape' || !isBusy || forceDisabled || stop === undefined) return;
                  event.preventDefault();
                  stop();
                }}
                className="text-text-primary placeholder:text-text-muted max-h-[8lh] min-h-10 w-full resize-none overflow-y-auto border-none bg-transparent px-1 py-1 text-[0.9375rem] leading-normal shadow-none outline-none disabled:cursor-not-allowed"
              />
            }
            className={cn(
              connectedToBanner && 'border-gold-line rounded-t-none border-t-0',
              !connectedToBanner && hasText && 'border-gold-line',
            )}
            disabled={disabled}
            canSubmit={canSubmit}
            isRunning={isBusy && !forceDisabled}
            isStopping={isStopping}
            onSubmit={submit}
            onCancel={stop}
            onAttach={canManageSession ? () => fileInputRef.current?.click() : undefined}
          />
        </ComposerPrimitive.Root>
      </ComposerPrimitive.AttachmentDropzone>
      <CompactionStatusLine />
    </>
  );
}

function ComposerWithOptionalDraft({
  placeholder,
  forceDisabled = false,
  connectedToBanner = false,
}: {
  placeholder: string;
  forceDisabled?: boolean;
  connectedToBanner?: boolean;
}) {
  const shell = useOptionalShellMode();
  const parentLeftSection = useSlot('ComposerLeftSection');
  const parentRightSection = useSlot('ComposerRightSection');
  const usesDefaultLeftSection = useSlotIsDefault('ComposerLeftSection');
  const usesDefaultRightSection = useSlotIsDefault('ComposerRightSection');
  const DraftComposerLeftSection = useSlot('DraftComposerLeftSection');
  const DraftComposerRightSection = useSlot('DraftComposerRightSection');
  const canMutateSpec = shell?.mode.status === 'active' && shell.mode.isMutable;

  if (canMutateSpec) {
    return (
      <DraftCatalogProvider>
        <SlotsProvider
          overrides={{
            ComposerLeftSection: usesDefaultLeftSection ? DraftComposerLeftSection : parentLeftSection,
            ComposerRightSection: usesDefaultRightSection ? DraftComposerRightSection : parentRightSection,
          }}
        >
          <ComposerBody placeholder={placeholder} forceDisabled={forceDisabled} connectedToBanner={connectedToBanner} />
        </SlotsProvider>
      </DraftCatalogProvider>
    );
  }

  return <ComposerBody placeholder={placeholder} forceDisabled={forceDisabled} connectedToBanner={connectedToBanner} />;
}

export function ComposerContainer({ placeholder: placeholderOverride }: ComposerContainerProps) {
  const pickedPlaceholder = useComposerPlaceholder();
  const placeholder = placeholderOverride ?? pickedPlaceholder;
  const pauseView = useComposerPauseView();
  const canManageSession = useActiveSessionCanManage();

  if (pauseView.kind === 'mcp') {
    return <McpAuthContainer disabled={!canManageSession} />;
  }
  if (pauseView.kind === 'custom') {
    return <CustomActionContainer disabled={!canManageSession} />;
  }
  if (pauseView.kind === 'ask-user') {
    return <AskUserContainer disabled={!canManageSession} />;
  }
  if (pauseView.kind === 'approval') {
    return (
      <div data-slot="aui_composer-approval-pause" className="flex w-full flex-col">
        <ApprovalNavContainer>
          {docked => <ComposerWithOptionalDraft placeholder={placeholder} forceDisabled connectedToBanner={docked} />}
        </ApprovalNavContainer>
      </div>
    );
  }

  return <ComposerWithOptionalDraft placeholder={placeholder} />;
}
