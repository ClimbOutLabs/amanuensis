/** The four approval choices, in the order every approval surface shows them. */
export const APPROVAL_CHOICES = {
  approve: { label: 'Approve', hint: 'Allow this one call only.' },
  approveForChat: { label: 'Approve for this chat', hint: 'Allow this kind of call for the rest of this chat.' },
  alwaysAllow: { label: 'Always allow', hint: 'Remember this for every chat.' },
  deny: { label: 'Deny', hint: 'Do not run this call.' },
} as const;
