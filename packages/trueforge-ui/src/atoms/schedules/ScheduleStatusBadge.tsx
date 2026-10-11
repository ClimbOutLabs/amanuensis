'use client';

import type { ScheduleStatus } from '../../server/types.js';
import { cn } from '../lib/cn.js';

export function ScheduleStatusBadge({ status }: { status: ScheduleStatus }) {
  const active = status === 'active';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        active ? 'border-success/30 bg-success/10 text-success' : 'border-warning/30 bg-warning/10 text-warning',
      )}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', active ? 'bg-success' : 'bg-warning')} aria-hidden />
      {active ? 'Active' : 'Paused'}
    </span>
  );
}
