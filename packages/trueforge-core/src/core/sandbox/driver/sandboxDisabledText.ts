/** Wording for an installer instance set up without the sandbox; Settings and the chat notice both use it. */
export const SANDBOX_DISABLED_HEADLINE = 'Code execution is off for this instance';
export const SANDBOX_DISABLED_SUMMARY = "Aman was installed without the sandbox, so it can't run code or read PDFs.";

/** The instance name stands in as "your instance" when the server does not know it. */
export function sandboxDisabledFix({ instance }: { instance: string | undefined }): string {
  const name = instance === undefined || instance === '' ? 'your instance' : instance;
  return `Run \`./installer/install.sh --name ${name}\` again on the computer where Aman is installed to turn it on, then press Re-check.`;
}

export function sandboxDisabledMessage({ instance }: { instance: string | undefined }): string {
  return `${SANDBOX_DISABLED_HEADLINE}. ${SANDBOX_DISABLED_SUMMARY} ${sandboxDisabledFix({ instance })}`;
}
