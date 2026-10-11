'use client';

import { Icon } from '../../icons/Icon.js';
import type { ScheduleRun } from '../../server/types.js';
import { cn } from '../lib/cn.js';
import { Tooltip } from '../primitives/Tooltip.js';
import { formatScheduleRunInstant, runChipKind, runStatusLabel } from './scheduleRuns.js';
import { ScheduleRunTooltip } from './ScheduleRunTooltip.js';

const CHIP_STYLES = {
  success: 'border-success-bg/30 bg-success-bg/10 text-success-bg',
  failed: 'border-failure-bg/30 bg-failure-bg/10 text-failure-bg',
} as const;

export function ScheduleRunChip({ run }: { run: ScheduleRun }) {
  const kind = runChipKind(run.status);
  const when = formatScheduleRunInstant(run.triggeredAt ?? run.scheduledFor);
  return (
    <Tooltip content={<ScheduleRunTooltip run={run} />} side="top">
      <span
        className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded-md border', CHIP_STYLES[kind])}
        aria-label={`${runStatusLabel(run.status)} run at ${when}`}
      >
        <Icon name={kind === 'failed' ? 'triangle-exclamation' : 'check'} className="size-3.5" />
      </span>
    </Tooltip>
  );
}
