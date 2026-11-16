import type { ExtractionResult } from './extractorRegistry.js';

/** The external-service sentence for a tool whose name names the kind of send, or null when it does not. */
export function externalServiceWhatSpecific(input: {
  tool_name: string;
  destination: string | null;
  recipient: string | null;
  amount: string | null;
}): string | null {
  const name = input.tool_name.toLowerCase();
  const where = input.recipient ?? input.destination ?? 'an external destination';
  if (name.includes('email') || name.includes('mail')) {
    if (name.includes('draft')) {
      return `Save an email draft for ${where}?`;
    }
    if (name.includes('forward')) {
      return `Forward an email to ${where}?`;
    }
    if (name.includes('reply')) {
      return `Reply to an email, sending it to ${where}?`;
    }
    return `Send an email to ${where}?`;
  }
  if (name.includes('sms') || name.includes('message') || name.includes('notify')) {
    return `Send a message to ${where}?`;
  }
  if (name.includes('post') || name.includes('publish') || name.includes('tweet')) {
    return `Publish a post${input.destination === null ? '' : ` to ${input.destination}`}?`;
  }
  if (name.includes('share') || name.includes('webhook')) {
    return `Share data with ${where}?`;
  }
  if (
    name.includes('pay') ||
    name.includes('spend') ||
    name.includes('charge') ||
    name.includes('transfer') ||
    name.includes('invoice')
  ) {
    return `Spend ${input.amount ?? 'money'}${input.destination === null ? '' : ` via ${input.destination}`}?`;
  }
  return null;
}

export function externalServiceWhat(input: {
  tool_name: string;
  destination: string | null;
  recipient: string | null;
  amount: string | null;
}): string {
  const where = input.recipient ?? input.destination ?? 'an external destination';
  return externalServiceWhatSpecific(input) ?? `Perform an external action affecting ${where}?`;
}

/**
 * The sentence for a call classified as an external-service send: the external-service sentence
 * when the tool's name names the kind of send, else the connector family's own sentence for the
 * call when a family described one, else the general external-action sentence.
 */
export function namedSendWhat(input: { tool_name: string; extraction: ExtractionResult }): string {
  const { fields } = input.extraction;
  const parts = {
    tool_name: input.tool_name,
    destination: fields.destination,
    recipient: fields.recipient,
    amount: fields.amount,
  };
  return externalServiceWhatSpecific(parts) ?? input.extraction.connector_what ?? externalServiceWhat(parts);
}
