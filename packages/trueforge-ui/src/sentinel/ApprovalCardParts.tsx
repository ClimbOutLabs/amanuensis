'use client';

import { forwardRef, useState, type ComponentProps, type ReactNode } from 'react';

import { cn } from '../atoms/lib/cn.js';
import { Button } from '../atoms/primitives/Button.js';
import { WAITING_FOR_YOU_LABEL } from './types.js';

/*
 * The pieces every approval card is built from, so a browser, mail, calendar, command or held card reads the same
 * way: one status line, the question, one quiet line on why it asks, each fact once, then the choices.
 */

/** Characters shown before a long value is folded behind "Show all". */
const FOLD_PREVIEW_CHARS = 500;

/** Text folded after a preview, cut on code points so a surrogate pair is never split. */
export function FoldedText({ text, as: Tag, className }: { text: string; as: 'pre' | 'span'; className: string }) {
  const [expanded, setExpanded] = useState(false);
  const points = Array.from(text);
  const isLong = points.length > FOLD_PREVIEW_CHARS;
  const shown = isLong && !expanded ? `${points.slice(0, FOLD_PREVIEW_CHARS).join('')}...` : text;
  return (
    <>
      <Tag className={className}>{shown}</Tag>
      {isLong && (
        <button
          type="button"
          onClick={() => {
            setExpanded(!expanded);
          }}
          aria-expanded={expanded}
          className="mt-1 block font-medium text-text-secondary underline hover:text-text-primary"
        >
          {expanded ? 'Show less' : `Show all (${String(points.length - FOLD_PREVIEW_CHARS)} more characters)`}
        </button>
      )}
    </>
  );
}

export type ApprovalCardStatus =
  /** The card waits on the person. */
  | { kind: 'waiting' }
  /** Answered, in words such as "Allowed · 09:14". */
  | { kind: 'answered'; text: string; tick?: ReactNode };

/** The card's frame: its status line, the question, the reason line, then the body and the choices. */
export function ApprovalCardShell({
  question,
  status,
  reason,
  highlighted = false,
  className,
  children,
  ...rest
}: Omit<ComponentProps<'article'>, 'children'> & {
  question: string;
  status: ApprovalCardStatus;
  /** Why the assistant is checking first, in one plain sentence, or null. */
  reason?: string | null | undefined;
  /** True for the one card per screen that takes the gold edge. */
  highlighted?: boolean;
  children?: ReactNode;
}) {
  const answered = status.kind === 'answered';
  return (
    <article
      {...rest}
      className={cn(
        'aui-approval-card aui-settle',
        highlighted && 'aui-approval-card--selected',
        answered && 'aui-approval-card--answered',
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        {answered ? (
          <p
            className="aui-approval-card__status flex min-w-0 items-center gap-1.5 text-text-secondary"
            data-role="approval-status"
          >
            {status.tick}
            <span className="min-w-0">{status.text}</span>
          </p>
        ) : (
          <p className="aui-approval-card__status flex items-center gap-1.5 text-gold-ink" data-role="approval-status">
            <span aria-hidden="true" className="size-[0.375rem] shrink-0 rounded-full bg-gold-ink" />
            {WAITING_FOR_YOU_LABEL}
          </p>
        )}
        <h3 className="aui-approval-card__title min-w-0 text-text-primary">{question}</h3>
      </div>
      {!answered && reason !== null && reason !== undefined && reason !== '' && (
        <p className="text-text-secondary" data-role="approval-reason">
          {reason}
        </p>
      )}
      {!answered && children}
    </article>
  );
}

export type ApprovalFact = {
  label: string;
  value: string;
  /** A command or other text read character by character. */
  mono?: boolean;
};

/** Each fact the card names, once, as label and value rows in one quiet box. Renders nothing for no facts. */
export function ApprovalFacts({ facts }: { facts: readonly ApprovalFact[] }) {
  if (facts.length === 0) return null;
  return (
    <dl className="aui-approval-card__facts">
      {facts.map(fact => (
        <div key={fact.label} className="contents">
          <dt className="text-text-secondary">{fact.label}</dt>
          <dd className="min-w-0">
            <FoldedText
              text={fact.value}
              as="span"
              className={cn('text-text-primary', fact.mono === true ? 'break-all font-mono' : 'break-words')}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The row of choices: even buttons side by side, sharing the row on a phone; `end` sits at the far side. */
export function ApprovalActions({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="aui-approval-card__actions">
      {children}
      {end !== undefined && <div className="aui-approval-card__actions-end">{end}</div>}
    </div>
  );
}

/** One choice in the row. Every choice is the same outlined button, so none is pressed on the person. */
export const ApprovalButton = forwardRef<HTMLButtonElement, Omit<ComponentProps<typeof Button>, 'variant' | 'size'>>(
  function ApprovalButton({ className, ...props }, ref) {
    return (
      <Button
        ref={ref}
        variant="secondary"
        size="large"
        className={cn('aui-approval-card__choice', className)}
        {...props}
      />
    );
  },
);
