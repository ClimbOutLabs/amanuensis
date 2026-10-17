/** Wording for an installer instance set up without the sandbox; Settings and the chat notice both use it. */
export const SANDBOX_DISABLED_HEADLINE = 'Code execution is off for this instance';
export const SANDBOX_DISABLED_SUMMARY = "Aman was installed without the sandbox, so it can't run code or read PDFs.";
export const SANDBOX_DISABLED_FIX = 'Run `aman doctor sandbox --fix` on the computer where Aman is installed.';

/** The chat has no Re-check button, so its notice stops at the command. */
export const SANDBOX_DISABLED_MESSAGE = `${SANDBOX_DISABLED_HEADLINE}. ${SANDBOX_DISABLED_SUMMARY} ${SANDBOX_DISABLED_FIX}`;
