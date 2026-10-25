'use client';

import { useAssistantDisplayName } from '../components/PersonalizationContext.js';
import { useOptionalReminders } from './RemindersContext.js';

/**
 * Asked once, under the first reminder that is set: whether the browser may show a notice when a reminder
 * is due. Nothing is asked again after the person answers, and the unread mark works either way.
 */
export function ReminderNotificationPrompt() {
  const reminders = useOptionalReminders();
  const assistant = useAssistantDisplayName();
  if (reminders === null || !reminders.shouldAskForNotifications) return null;
  return (
    <div
      data-role="reminder-notification-prompt"
      className="border-border bg-secondary-bg text-text-primary mt-2 rounded-xl border px-3 py-2 text-sm"
    >
      <p>
        Want a pop-up when a reminder is due? {assistant} can show a notice in your browser while this page is open. If
        the page is closed, you will see the reminder next time you open it.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={reminders.allowNotifications}
          className="bg-primary-button-bg text-primary-button-text rounded-lg px-3 py-1 text-sm font-medium"
        >
          Turn on notices
        </button>
        <button
          type="button"
          onClick={reminders.declineNotifications}
          className="text-text-secondary hover:bg-ghost-button-hover rounded-lg px-3 py-1 text-sm"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
