'use client';

import { ComposerPrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { useTrueFoundryAgentSpec, useTrueFoundryCancel } from '@truefoundry/assistant-ui-runtime';
import { useEffect, useRef, useState } from 'react';

import { CompactionStatusLine } from '../atoms/CompactionStatusLine.js';
import { DraftCatalogProvider } from '../atoms/draft/DraftCatalogProvider.js';
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
import { useWorkOnRepoMenuAction } from './WorkOnRepoControls.js';

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
  /** Flatten top radius/border so the approval banner sits flush above. */
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
  const workOnRepo = useWorkOnRepoMenuAction();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const disabled = isBusy || forceDisabled || !canManageSession;
  const canSubmit = canSubmitComposer({ disabled, hasText, hasAttachments, requiresModel, hasModel });
  const submit = () => {
    if (!canSubmit) return;
    send(() => aui.composer().send());
  };

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
            className={
              connectedToBanner
                ? // Banner owns the top accent; composer keeps its normal chrome without a shared blue frame.
                  'rounded-t-none border-t-0 focus-within:ring-0'
                : undefined
            }
            attachments={<ComposerAttachmentsContainer />}
            workOnRepo={workOnRepo}
            input={
              <ComposerPrimitive.Input
                data-slot="aui_composer-input"
                placeholder={placeholder}
                disabled={disabled}
                submitMode="enter"
                aria-label="Message input"
                className="aman-chat-text text-text-primary placeholder:text-text-secondary/80 max-h-[10lh] min-h-10 w-full resize-none overflow-y-auto rounded-lg border-none bg-transparent px-1 py-1 leading-normal shadow-none outline-none disabled:cursor-not-allowed"
              />
            }
            disabled={disabled}
            canSubmit={canSubmit}
            isRunning={isBusy && !forceDisabled}
            isStopping={isStopping}
            onSubmit={submit}
            onCancel={
              canManageSession
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
                : undefined
            }
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
        <ApprovalNavContainer />
        <ComposerWithOptionalDraft placeholder={placeholder} forceDisabled connectedToBanner />
      </div>
    );
  }

  return <ComposerWithOptionalDraft placeholder={placeholder} />;
}
