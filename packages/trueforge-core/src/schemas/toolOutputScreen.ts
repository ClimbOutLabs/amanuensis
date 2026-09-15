import { z } from '@hono/zod-openapi';

export const ToolOutputScreenFailureReasonCodeSchema = z
  .enum([
    'screen_not_configured',
    'screen_timeout',
    'screen_http_error',
    'screen_request_failed',
    'screen_response_too_large',
    'screen_malformed_response',
    'screen_response_unreadable',
    'screen_cancelled',
    'screen_internal_error',
  ])
  .openapi('ToolOutputScreenFailureReasonCode');

const ToolOutputScreenPassedSchema = z.object({
  status: z.literal('passed'),
  action: z.literal('admitted'),
  reason_code: z.literal('classifier_benign'),
  score: z.number().gte(0).lte(1),
});

const ToolOutputScreenFlaggedSchema = z.object({
  status: z.literal('flagged'),
  action: z.literal('withheld'),
  reason_code: z.literal('classifier_malicious'),
  score: z.number().gte(0).lte(1),
});

const ToolOutputScreenUnknownSchema = z.object({
  status: z.literal('unknown'),
  action: z.literal('withheld'),
  reason_code: ToolOutputScreenFailureReasonCodeSchema,
});

export const ToolOutputScreenDecisionSchema = z
  .discriminatedUnion('status', [
    ToolOutputScreenPassedSchema,
    ToolOutputScreenFlaggedSchema,
    ToolOutputScreenUnknownSchema,
  ])
  .openapi('ToolOutputScreenDecision');

export type ToolOutputScreenFailureReasonCode = z.infer<typeof ToolOutputScreenFailureReasonCodeSchema>;
export type ToolOutputScreenDecision = z.infer<typeof ToolOutputScreenDecisionSchema>;

/** Canonical classifier outcome consumed by recall screening and live tool-output screening. */
export interface ToolOutputScreenClassification {
  ok: boolean;
  flagged: boolean;
  score: number;
  reasonCode: ToolOutputScreenFailureReasonCode | null;
}
