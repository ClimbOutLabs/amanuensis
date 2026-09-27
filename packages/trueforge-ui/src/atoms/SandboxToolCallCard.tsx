'use client';

import type { ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { cn } from './lib/cn.js';
import type { ToolCallStatus } from './ToolCallCard.js';

export type SandboxToolCallCardProps = {
  name: string;
  intent?: string;
  status: ToolCallStatus;
  expanded: boolean;
  onToggle: () => void;
  command?: string;
  summary?: string;
  exitCode?: number | null;
  argsJson?: string;
  resultText?: string;
  resultJson?: string;
  viewMode?: 'terminal' | 'code';
  hasContent?: boolean;
  onViewModeChange?: (viewMode: 'terminal' | 'code') => void;
  durationText?: string;
  outcomeText?: string;
  approvalSlot?: ReactNode;
  /** When set, this card is the scroll/flash target for approval banner navigation. */
  approvalId?: string;
  dataTestPrefix?: string;
  className?: string;
};

function JsonPane({ value, className }: { value: string; className?: string }) {
  const MonacoEditorCore = useSlot('MonacoEditorCore');

  return (
    <MonacoEditorCore
      language="json"
      value={value}
      autoHeight
      maxHeight="10.5rem"
      options={{
        readOnly: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        lineNumbers: 'off',
        folding: true,
        fontSize: 12,
      }}
      className={cn('!border-0', className)}
    />
  );
}

function SandboxBody({
  command,
  summary,
  exitCode,
  argsJson,
  resultText,
  resultJson,
  viewMode = 'terminal',
  hasContent = false,
  onViewModeChange,
  dataTestPrefix,
}: Pick<
  SandboxToolCallCardProps,
  | 'command'
  | 'summary'
  | 'exitCode'
  | 'argsJson'
  | 'resultText'
  | 'resultJson'
  | 'viewMode'
  | 'hasContent'
  | 'onViewModeChange'
  | 'dataTestPrefix'
>) {
  const terminalAvailable = Boolean(command || summary || resultText || resultJson);
  const codeAvailable = Boolean(argsJson || resultJson);

  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-card-bg"
      data-testid={dataTestPrefix ? `${dataTestPrefix}-sandbox` : undefined}
    >
      <div className="border-b border-border bg-secondary-bg/60">
        <div className="flex w-full min-w-0 items-center gap-2 px-3 py-2">
          <p className="min-w-0 font-sans text-xs font-medium text-text-secondary">Execution details</p>
          <div
            className="ml-auto flex shrink-0 items-center gap-1.5"
            onClick={e => e.stopPropagation()}
            onKeyDown={e => e.stopPropagation()}
          >
            {exitCode != null && (
              <span
                className={cn(
                  'inline-flex h-7 items-center gap-1 rounded-md border px-2 font-sans text-xs',
                  exitCode === 0 ? 'bg-success-bg/10 text-success-bg' : 'bg-failure-bg/10 text-failure-bg',
                )}
                data-testid={dataTestPrefix ? `${dataTestPrefix}-exit-code` : undefined}
              >
                <Icon name={exitCode === 0 ? 'circle-check' : 'circle-xmark'} size={12} />
                Exit {exitCode}
              </span>
            )}
            <div
              className="inline-flex items-center rounded-md border border-border bg-primary-bg p-0.5"
              role="group"
              aria-label="Sandbox view"
            >
              <button
                type="button"
                title="Terminal View"
                aria-label="Terminal View"
                aria-pressed={viewMode === 'terminal'}
                disabled={!terminalAvailable}
                onClick={() => onViewModeChange?.('terminal')}
                className={cn(
                  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded px-2 font-sans text-xs text-text-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-button-bg/60 disabled:cursor-not-allowed disabled:opacity-40',
                  viewMode === 'terminal' && 'bg-dropdown-selected-item-bg text-dropdown-selected-item-text shadow-sm',
                )}
              >
                <Icon name="terminal" size={12} />
                Terminal
              </button>
              <button
                type="button"
                title="Code View"
                aria-label="Code View"
                aria-pressed={viewMode === 'code'}
                disabled={!codeAvailable}
                onClick={() => onViewModeChange?.('code')}
                className={cn(
                  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded px-2 font-sans text-xs text-text-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-button-bg/60 disabled:cursor-not-allowed disabled:opacity-40',
                  viewMode === 'code' && 'bg-dropdown-selected-item-bg text-dropdown-selected-item-text shadow-sm',
                )}
              >
                <Icon name="code" size={12} />
                Details
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="p-3">
        {hasContent && (
          <div className="max-h-80 overflow-auto font-mono text-xs text-text-primary">
            {viewMode === 'code' ? (
              <>
                {argsJson && (
                  <div className="my-1">
                    <div className="mb-1 font-sans text-xs font-medium leading-4">Arguments</div>
                    <JsonPane value={argsJson} className="pl-2" />
                  </div>
                )}
                {resultJson && (
                  <div className="my-1">
                    <div className="mb-1 mt-2 font-sans text-xs font-medium leading-4">Result</div>
                    <JsonPane value={resultJson} className="pl-2" />
                  </div>
                )}
              </>
            ) : (
              <>
                {(command || summary) && (
                  <div className="my-1 min-w-max">
                    <div className="mb-1 font-sans text-xs font-medium leading-4 text-text-secondary">
                      {command ? 'Command' : 'Changes'}
                    </div>
                    <div className="whitespace-pre">
                      {command ? (
                        <>
                          <span className="text-primary-button-bg">$</span> {command}
                        </>
                      ) : (
                        summary
                      )}
                    </div>
                  </div>
                )}
                {resultText ? (
                  <>
                    <div className="mx-3 my-1 border-t border-border" />
                    <div className="my-1 min-w-max">
                      <div className="mb-1 font-sans text-xs font-medium leading-4 text-text-secondary">Output</div>
                      <div className="whitespace-pre">{resultText}</div>
                    </div>
                  </>
                ) : (
                  resultJson && (
                    <>
                      <div className="mx-3 my-1 border-t border-border" />
                      <div className="my-1">
                        <div className="mb-1 font-sans text-xs font-medium leading-4 text-text-secondary">Output</div>
                        <JsonPane value={resultJson} className="pl-2" />
                      </div>
                    </>
                  )
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function SandboxToolCallCard({
  name,
  intent,
  status,
  expanded,
  onToggle,
  command,
  summary,
  exitCode,
  argsJson,
  resultText,
  resultJson,
  viewMode = 'terminal',
  hasContent = false,
  onViewModeChange,
  durationText,
  outcomeText,
  approvalSlot,
  approvalId,
  dataTestPrefix,
  className,
}: SandboxToolCallCardProps) {
  const ToolCallCard = useSlot('ToolCallCard');
  const awaiting = status === 'running';

  return (
    <ToolCallCard
      toolName={intent || name}
      icon="cube"
      iconClassName="text-primary-button-bg shrink-0"
      expanded={expanded}
      onToggle={onToggle}
      awaiting={awaiting}
      awaitingText={durationText ?? 'Running…'}
      outcomeText={outcomeText}
      showResponseLine={false}
      status={awaiting ? undefined : status}
      exitCode={exitCode}
      approvalSlot={approvalSlot}
      approvalId={approvalId}
      dataTestPrefix={dataTestPrefix}
      requestSlot={
        hasContent ? (
          <SandboxBody
            command={command}
            summary={summary}
            exitCode={exitCode}
            argsJson={argsJson}
            resultText={resultText}
            resultJson={resultJson}
            viewMode={viewMode}
            hasContent={hasContent}
            onViewModeChange={onViewModeChange}
            dataTestPrefix={dataTestPrefix}
          />
        ) : undefined
      }
      className={cn('aui-sandbox-tool-call-card', className)}
    />
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    SandboxToolCallCard: typeof SandboxToolCallCard;
  }
}
