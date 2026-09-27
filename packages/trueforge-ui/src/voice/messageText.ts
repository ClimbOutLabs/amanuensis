import type { ThreadAssistantMessagePart, ThreadUserMessagePart } from '@assistant-ui/react';

/**
 * Plain-text rendering of a message's parts, for read-aloud and transcripts.
 * Internal reasoning never surfaces here.
 */
export function messageTextOf(content: readonly (ThreadAssistantMessagePart | ThreadUserMessagePart)[]): string {
  const lines: string[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text': {
        const text = part.text.trim();
        if (text.length > 0) lines.push(text);
        break;
      }
      case 'reasoning':
        // Internal reasoning stays out of read-aloud and transcripts.
        break;
      case 'image':
        lines.push('[image]');
        break;
      case 'file':
        lines.push('[file]');
        break;
      case 'tool-call':
        lines.push(`[tool: ${part.toolName}]`);
        break;
      case 'source':
        lines.push(`[source: ${part.title ?? part.url}]`);
        break;
      case 'data':
        lines.push('[data]');
        break;
      case 'audio':
        lines.push('[audio]');
        break;
      case 'generative-ui':
        lines.push('[generated content]');
        break;
      default:
        break;
    }
  }
  return lines.join('\n\n');
}
