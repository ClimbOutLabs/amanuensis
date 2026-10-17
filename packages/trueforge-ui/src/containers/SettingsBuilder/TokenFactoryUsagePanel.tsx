'use client';

import { Button } from '@/atoms/primitives/Button.js';
import { useOptionalSentinelApiState } from '@/sentinel/SentinelApiContext.js';
import { formatCostUsd, formatTokens, LIST_PRICE_HINT } from '@/utils/modelUsage.js';
import { useTokenFactoryUsage } from './tokenFactoryUsage.js';

function Cost({ value }: { value: number | null }) {
  return <>{value === null ? 'no price' : formatCostUsd(value)}</>;
}

/**
 * Today's Token Factory traffic: tokens and cost per model, and the daily cap with what is left.
 * Shown on the Models page, where the provider is connected. Renders nothing when the server has
 * no usage port, or when there is no Token Factory provider and nothing was counted today.
 */
export function TokenFactoryUsagePanel({ providerConfigured }: { providerConfigured: boolean }) {
  const { supported, usage, loading, error, refresh } = useTokenFactoryUsage();
  const offline = useOptionalSentinelApiState()?.settings?.offline_mode ?? false;
  if (!supported) return null;
  if (usage === null && error === null) {
    return loading ? <p className="mt-4 text-sm text-text-secondary">Loading today's usage…</p> : null;
  }
  if (usage !== null && !providerConfigured && usage.models.length === 0 && usage.capTokens === null) return null;

  const capPercent =
    usage === null || usage.capTokens === null
      ? 0
      : Math.min(100, Math.round((usage.usedTokens / usage.capTokens) * 100));

  return (
    <section
      aria-labelledby="token-factory-usage-heading"
      data-testid="token-factory-usage"
      className="mt-4 rounded-xl border border-border bg-card-bg p-3"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 id="token-factory-usage-heading" className="text-sm font-medium text-text-primary">
            Token Factory today
          </h4>
          <p className="mt-0.5 text-xs text-text-secondary">
            {usage === null ? 'Not available.' : `UTC day ${usage.usageDate}. Counters reset at midnight UTC.`}
          </p>
        </div>
        <Button.Secondary type="button" onClick={refresh} disabled={loading}>
          Refresh
        </Button.Secondary>
      </header>

      {offline ? (
        <p
          role="status"
          data-testid="token-factory-offline-notice"
          className="mt-2 rounded-md border border-warning-bg/40 bg-warning-bg/10 px-2.5 py-1.5 text-xs text-text-primary"
        >
          Offline mode is on. It stops tools from reaching the internet, but Token Factory is online, so its answers
          still travel over the internet. To keep everything on this device, pick a model that runs here.
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className="mt-2 text-sm text-failure-bg">
          {error}
        </p>
      ) : null}

      {usage === null ? null : (
        <>
          <div className="mt-3" data-testid="token-factory-cap">
            {usage.capTokens === null ? (
              <p className="text-sm text-text-secondary">
                No daily cap. {formatTokens(usage.usedTokens)} tokens used today.
              </p>
            ) : (
              <>
                <p className="text-sm text-text-primary">
                  {formatTokens(usage.remainingTokens ?? 0)} of {formatTokens(usage.capTokens)} tokens remaining
                </p>
                <div
                  role="progressbar"
                  aria-label="Daily token cap used"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={capPercent}
                  className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border"
                >
                  <div
                    className="h-full rounded-full bg-primary-button-bg"
                    style={{ width: `${String(capPercent)}%` }}
                  />
                </div>
              </>
            )}
          </div>

          {usage.models.length === 0 ? (
            <p className="mt-3 text-sm text-text-secondary">No Token Factory calls yet today.</p>
          ) : (
            <table className="mt-3 w-full text-left text-sm">
              <thead className="text-xs text-text-secondary">
                <tr>
                  <th scope="col" className="py-1 font-medium">
                    Model
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Calls
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Input
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Output
                  </th>
                  <th scope="col" title={LIST_PRICE_HINT} className="py-1 text-right font-medium">
                    Cost at list price
                  </th>
                </tr>
              </thead>
              <tbody className="text-text-primary">
                {usage.models.map(model => (
                  <tr key={model.modelId} data-testid="token-factory-model-row" className="border-t border-border">
                    <th scope="row" className="py-1.5 font-normal">
                      {model.displayName}
                    </th>
                    <td className="py-1.5 text-right tabular-nums">{formatTokens(model.calls)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatTokens(model.inputTokens)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatTokens(model.outputTokens)}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      <Cost value={model.costUsd} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-medium text-text-primary">
                  <th scope="row" className="py-1.5 font-medium">
                    Total
                  </th>
                  <td />
                  <td colSpan={2} className="py-1.5 text-right tabular-nums">
                    {formatTokens(usage.usedTokens)} tokens
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    <Cost value={usage.costUsd} />
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </>
      )}
    </section>
  );
}
