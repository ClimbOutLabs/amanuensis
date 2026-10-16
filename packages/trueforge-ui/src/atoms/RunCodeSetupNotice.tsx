import { useState } from 'react';

import { Icon } from '../icons/Icon.js';
import { copyText } from '../utils/copyText.js';
import { splitHttpsLinks } from '../utils/splitHttpsLinks.js';
import { cn } from './lib/cn.js';

export type RunCodeSetupNoticeProps = {
  /** The failure text exactly as the server wrote it; https URLs in it become links. */
  message: string;
  className?: string;
};

/** A command the server wrote between backticks, shown in a box that can be copied. */
function CommandBox({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="mx-0.5 inline-flex items-center gap-1 rounded border border-border bg-card-bg px-1.5 py-0.5 align-baseline">
      <code data-testid="run-code-setup-notice-command" className="font-mono text-xs">
        {command}
      </code>
      <button
        type="button"
        aria-label={copied ? 'Copied' : 'Copy command'}
        className="inline-flex shrink-0 items-center rounded-sm text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-button-bg/60"
        onClick={() => {
          void copyText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size="0.875em" aria-hidden="true" />
      </button>
    </span>
  );
}

/** Splits the server's text into plain stretches and the commands it quoted. */
function splitCommands(message: string): ({ kind: 'text'; text: string } | { kind: 'command'; command: string })[] {
  const parts: ({ kind: 'text'; text: string } | { kind: 'command'; command: string })[] = [];
  let last = 0;
  for (const match of message.matchAll(/`([^`\n]+)`/g)) {
    if (match.index > last) parts.push({ kind: 'text', text: message.slice(last, match.index) });
    parts.push({ kind: 'command', command: match[1] ?? '' });
    last = match.index + match[0].length;
  }
  if (last < message.length) parts.push({ kind: 'text', text: message.slice(last) });
  return parts;
}

/**
 * Tells the user their code did not run and why, in the server's own words. The wording is never
 * rewritten, so a link or install step the server gave reaches the user intact; a command it quoted
 * can be copied.
 */
export function RunCodeSetupNotice({ message, className }: RunCodeSetupNoticeProps) {
  return (
    <div
      role="status"
      data-testid="run-code-setup-notice"
      className={cn(
        'mt-2 flex items-start gap-2 rounded-md border border-warning-bg/40 bg-warning-bg/10 px-3 py-2 text-sm text-text-primary',
        className,
      )}
    >
      <Icon name="triangle-exclamation" className="mt-0.5 shrink-0 text-warning-bg" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-medium">Code was not run</p>
        <p data-testid="run-code-setup-notice-message" className="whitespace-pre-wrap break-words">
          {splitCommands(message).map((part, partIndex) =>
            part.kind === 'command' ? (
              <CommandBox key={`command-${String(partIndex)}`} command={part.command} />
            ) : (
              splitHttpsLinks(part.text).map(segment =>
                segment.kind === 'link' ? (
                  <a
                    key={`${String(partIndex)}-${String(segment.start)}`}
                    href={segment.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-sm underline underline-offset-2 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-button-bg/60"
                  >
                    {segment.text}
                  </a>
                ) : (
                  <span key={`${String(partIndex)}-${String(segment.start)}`}>{segment.text}</span>
                ),
              )
            ),
          )}
        </p>
      </div>
    </div>
  );
}
