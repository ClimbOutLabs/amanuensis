'use client';

import type { ReactNode } from 'react';

import { cn } from '../atoms/lib/cn.js';
import type { TourIllustrationKey } from './tourPrompts.js';

/**
 * One line drawing per capability ticket. Ink is currentColor; the gold marks take the theme's gold
 * tokens through Tailwind, so no colour literal lives in this file.
 */
const DRAWINGS: Record<TourIllustrationKey, ReactNode> = {
  email: (
    <>
      <rect x="6" y="12" width="36" height="24" rx="3" />
      <path d="M7 14 L24 27 L41 14" />
      <circle cx="38" cy="10" r="4" className="fill-gold" stroke="none" />
    </>
  ),
  subscriptions: (
    <>
      <rect x="8" y="9" width="32" height="8" rx="2" />
      <rect x="8" y="20" width="32" height="8" rx="2" />
      <rect x="8" y="31" width="20" height="8" rx="2" />
      <circle cx="37" cy="35" r="4" className="fill-gold" stroke="none" />
    </>
  ),
  reply: (
    <>
      <path d="M8 12 H30 A4 4 0 0 1 34 16 V26 A4 4 0 0 1 30 30 H18 L11 36 V30 H8 A3 3 0 0 1 5 27 V15 A3 3 0 0 1 8 12 Z" />
      <path d="M38 22 V16 A4 4 0 0 0 34 12" className="stroke-gold-ink" />
    </>
  ),
  schedule: (
    <>
      <circle cx="24" cy="24" r="16" />
      <path d="M24 14 V24 L31 28" />
      <path d="M38 8 A18 18 0 0 1 42 16" className="stroke-gold-ink" />
    </>
  ),
  calendar: (
    <>
      <rect x="8" y="11" width="32" height="28" rx="3" />
      <path d="M8 20 H40 M16 7 V14 M32 7 V14" />
      <rect x="26" y="26" width="7" height="6" rx="1" className="fill-gold" stroke="none" />
    </>
  ),
  places: (
    <>
      <path d="M24 41 C24 41 12 29 12 20 A12 12 0 0 1 36 20 C36 29 24 41 24 41 Z" />
      <circle cx="24" cy="20" r="4" className="fill-gold" />
    </>
  ),
  web: (
    <>
      <circle cx="24" cy="24" r="16" />
      <ellipse cx="24" cy="24" rx="7" ry="16" />
      <path d="M8 24 H40" />
      <path d="M12 16 Q24 20 36 16" className="stroke-gold-ink" />
    </>
  ),
  spaces: (
    <>
      <rect x="8" y="8" width="14" height="14" rx="2" />
      <rect x="26" y="8" width="14" height="14" rx="2" className="fill-gold" />
      <rect x="8" y="26" width="14" height="14" rx="2" />
      <rect x="26" y="26" width="14" height="14" rx="2" />
    </>
  ),
  specialists: (
    <>
      <circle cx="17" cy="18" r="5" />
      <path d="M8 38 C8 30 12 27 17 27 C22 27 26 30 26 38" />
      <circle cx="32" cy="18" r="5" className="fill-gold" />
      <path d="M23 38 C23 30 27 27 32 27 C37 27 40 30 40 38" />
    </>
  ),
  code: (
    <>
      <path d="M18 14 L8 24 L18 34" />
      <path d="M30 14 L40 24 L30 34" />
      <path d="M27 11 L21 37" className="stroke-gold-ink" />
    </>
  ),
  memory: (
    <>
      <rect x="10" y="8" width="28" height="32" rx="3" />
      <path d="M17 17 H31 M17 24 H31 M17 31 H26" />
      <path d="M31 8 V20 L28 17 L25 20 V8" className="fill-gold" />
    </>
  ),
  skills: (
    <>
      <rect x="8" y="30" width="8" height="10" rx="1" />
      <rect x="20" y="22" width="8" height="18" rx="1" />
      <rect x="32" y="12" width="8" height="28" rx="1" className="fill-gold" />
    </>
  ),
};

/** A small drawing for a capability ticket. Decoration only: the ticket's label says what it is. */
export function TourIllustration({ name, className }: { name: TourIllustrationKey; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-10 shrink-0 text-text-secondary', className)}
    >
      {DRAWINGS[name]}
    </svg>
  );
}
