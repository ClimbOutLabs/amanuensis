'use client';

import { useAssistantDisplayName } from '../components/PersonalizationContext.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import { useOptionalDeliveries } from './DeliveriesContext.js';

/**
 * Where a person connects mail, says the assistant can watch it and that this waits for the switch in
 * Reach me. Hidden where Reach me does not exist, so it never points at a page that is not there.
 */
export function WatchMailNote({
  onOpenReachMe,
}: {
  /** Closes the panel the note sits in. */ onOpenReachMe: () => void;
}) {
  const deliveries = useOptionalDeliveries();
  const shell = useOptionalShellMode();
  const assistant = useAssistantDisplayName();
  if (deliveries === null) {
    return null;
  }
  return (
    <section
      aria-labelledby="watch-mail-note-heading"
      data-testid="watch-mail-note"
      className="space-y-2 rounded-md border border-border bg-card-bg px-3 py-2"
    >
      <p id="watch-mail-note-heading" className="m-0 font-medium">
        {assistant} can watch your mail for you
      </p>
      <p className="m-0 text-text-secondary">
        It can tell you about bills that are due soon, and about mail from people you mark always important. This is off
        until you turn it on, in Settings, Reach me.
      </p>
      {shell === null ? null : (
        <button
          type="button"
          className="cursor-pointer appearance-none border-0 bg-transparent p-0 font-[inherit] text-link underline underline-offset-2"
          onClick={() => {
            onOpenReachMe();
            shell.setSettingsOpen(true, 'reach-me');
          }}
        >
          Open Reach me
        </button>
      )}
    </section>
  );
}
