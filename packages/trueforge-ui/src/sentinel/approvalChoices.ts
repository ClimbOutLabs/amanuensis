/** The four approval choices, in the order every approval surface shows them. */
export const APPROVAL_CHOICES = {
  approve: { label: 'Approve', hint: 'Allow this one call only.' },
  approveForChat: { label: 'Approve for this chat', hint: 'Allow this kind of call for the rest of this chat.' },
  alwaysAllow: { label: 'Always allow', hint: 'Remember this for every chat.' },
  alwaysAllowTool: {
    label: 'Always allow this tool',
    hint: 'Run this tool on this connector without asking, in every chat, until you remove it in settings.',
  },
  deny: { label: 'Deny', hint: 'Do not run this call.' },
} as const;

/**
 * The option id that asks the runtime for a standing grant: the patched runtime maps it to scope
 * "always" (patches/@truefoundry__assistant-ui-runtime). Keep the two in step.
 */
export const ALWAYS_ALLOW_TOOL_OPTION_ID = 'allow-standing';
