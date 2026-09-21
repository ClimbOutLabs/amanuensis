'use client';

import { Icon } from '../../icons/Icon.js';
import type { SessionMetricBarDatum } from '../../utils/buildSessionMetrics.js';
import { formatCostUsd, formatDurationMs, formatTokenCount } from '../../utils/sessionDisplayFormat.js';
import { formatTimelineDuration } from '../../utils/sessionEventTimeline.js';
import { LightTooltip } from '../primitives/Tooltip.js';
import { StackedProportionBar } from './AgentSessionMetricCharts.js';
import type { AgentSessionTurnHeaderProps } from './types.js';

function TurnTokenBreakdownTooltip({
  inputTokens,
  outputTokens,
  cachedTokens,
}: {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}) {
  const rows = [
    { label: 'Input', value: inputTokens },
    { label: 'Output', value: outputTokens },
    { label: 'Cached', value: cachedTokens },
  ] as const;
  return (
    <div className="min-w-28 px-2 py-1.5 text-xs text-text-primary">
      <div className="flex flex-col gap-1">
        {rows.map(row => (
          <div key={row.label} className="flex items-center justify-between gap-4">
            <span className="text-text-secondary">{row.label}</span>
            <span className="tabular-nums font-medium text-text-primary">{formatTokenCount(row.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TurnTimeBreakdownTooltip({ timeBreakdown }: { timeBreakdown: SessionMetricBarDatum[] }) {
  return (
    <div className="min-w-48 px-2 py-1.5 text-xs text-text-primary">
      <div className="mb-2 font-medium text-text-secondary">Where the time went</div>
      <StackedProportionBar data={timeBreakdown} formatValue={formatTimelineDuration} />
    </div>
  );
}

export function AgentSessionTurnHeader({
  turnNumber,
  totalTokens,
  inputTokens,
  outputTokens,
  cachedTokens,
  durationMs,
  timeBreakdown,
  totalCostInUsd,
}: AgentSessionTurnHeaderProps) {
  const hasMetrics = totalTokens != null || durationMs != null || totalCostInUsd != null;
  const hasTokenBreakdown = inputTokens != null || outputTokens != null || cachedTokens != null;
  const breakdownInput = inputTokens ?? 0;
  const breakdownOutput = outputTokens ?? 0;
  const breakdownCached = cachedTokens ?? 0;

  const durationTrigger =
    durationMs != null ? (
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-sm text-inherit"
        aria-label={
          timeBreakdown != null
            ? `Duration ${formatDurationMs(durationMs)}. ${timeBreakdown
                .map(datum => `${datum.label} ${formatTimelineDuration(datum.value)}`)
                .join(', ')}`
            : `Duration ${formatDurationMs(durationMs)}`
        }
      >
        <Icon name="clock" className="size-3.5 shrink-0" aria-hidden />
        {`Duration ${formatDurationMs(durationMs)}`}
      </button>
    ) : null;

  const tokensTrigger =
    totalTokens != null ? (
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-sm text-inherit"
        aria-label={
          hasTokenBreakdown
            ? `Tokens ${formatTokenCount(totalTokens)}. Input ${formatTokenCount(breakdownInput)}, Output ${formatTokenCount(breakdownOutput)}, Cached ${formatTokenCount(breakdownCached)}`
            : `Tokens ${formatTokenCount(totalTokens)}`
        }
      >
        <Icon name="link" className="size-3.5 shrink-0" aria-hidden />
        {`Tokens ${formatTokenCount(totalTokens)}`}
      </button>
    ) : null;

  return (
    <div className="flex items-center gap-3 py-1 text-xs text-text-secondary">
      <span className="shrink-0 font-semibold text-text-primary">{`Turn ${turnNumber}`}</span>
      <div className="h-px min-w-4 flex-1 bg-border" aria-hidden="true" />
      {hasMetrics ? (
        <div className="flex shrink-0 items-center gap-3 tabular-nums">
          {tokensTrigger != null ? (
            hasTokenBreakdown ? (
              <LightTooltip
                title={
                  <TurnTokenBreakdownTooltip
                    inputTokens={breakdownInput}
                    outputTokens={breakdownOutput}
                    cachedTokens={breakdownCached}
                  />
                }
                side="bottom"
              >
                {tokensTrigger}
              </LightTooltip>
            ) : (
              tokensTrigger
            )
          ) : null}
          {durationTrigger != null ? (
            timeBreakdown != null ? (
              <LightTooltip title={<TurnTimeBreakdownTooltip timeBreakdown={timeBreakdown} />} side="bottom">
                {durationTrigger}
              </LightTooltip>
            ) : (
              durationTrigger
            )
          ) : null}
          {totalCostInUsd != null ? <span>{`Cost ${formatCostUsd(totalCostInUsd)}`}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    AgentSessionTurnHeader: typeof AgentSessionTurnHeader;
  }
}
