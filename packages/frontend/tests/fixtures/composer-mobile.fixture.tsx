import {
  ComposerShell,
  SlotsProvider,
  type ComposerLeftSectionProps,
  type ComposerRightSectionProps,
} from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

function AddOnsControl({ disabled, isRunning }: ComposerLeftSectionProps) {
  return (
    <button
      type="button"
      disabled={disabled || isRunning}
      aria-label="Add-ons (2)"
      className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs"
    >
      <span>Add-ons</span>
      <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold">2</span>
    </button>
  );
}

function ModelAndReasoningControls({ disabled, isRunning }: ComposerRightSectionProps) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <div className="aui-composer-model-selector relative min-w-0 shrink">
        <button
          type="button"
          disabled={disabled || isRunning}
          aria-label="Select model"
          className="aui-composer-model-button inline-flex h-8 w-full max-w-[10rem] min-w-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium"
        >
          <span className="truncate">openai/gpt-4.1-mini</span>
          <span aria-hidden="true">⌄</span>
        </button>
      </div>
      <div className="aui-composer-reasoning-selector relative min-w-0 shrink">
        <button
          type="button"
          disabled={disabled || isRunning}
          aria-label="Select reasoning effort"
          className="aui-composer-reasoning-button inline-flex h-8 w-full max-w-[10rem] min-w-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium"
        >
          <span className="truncate">high reasoning</span>
          <span aria-hidden="true">⌄</span>
        </button>
      </div>
    </div>
  );
}

function MobileComposerFixture() {
  const [isRunning, setIsRunning] = useState(false);

  return (
    <SlotsProvider
      overrides={{
        ComposerLeftSection: AddOnsControl,
        ComposerRightSection: ModelAndReasoningControls,
      }}
    >
      <ComposerShell
        input={
          <textarea
            aria-label="Message"
            defaultValue="Check the latest notes"
            className="min-h-16 w-full resize-none border-0 bg-transparent p-2 text-base"
          />
        }
        disabled={false}
        canSubmit={!isRunning}
        isRunning={isRunning}
        onSubmit={() => {
          document.body.dataset.submitted = 'true';
          setIsRunning(true);
        }}
        onCancel={() => {
          document.body.dataset.cancelled = 'true';
          setIsRunning(false);
        }}
      />
    </SlotsProvider>
  );
}

const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('Missing fixture root');

createRoot(rootElement).render(<MobileComposerFixture />);
