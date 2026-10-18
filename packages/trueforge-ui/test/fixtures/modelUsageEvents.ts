import type { ModelUsageEvent } from '@/utils/modelUsage.js';

export const SUPER_EVENT: ModelUsageEvent = {
  type: 'aman.model.usage',
  id: 'evt_usage_chat',
  createdAt: '2026-10-15T12:00:00.000Z',
  role: 'chat',
  modelName: 'tokenfactory/nemotron-3-super-120b-a12b',
  modelId: 'nvidia/nemotron-3-super-120b-a12b',
  displayName: 'Nemotron 3 Super',
  provider: 'tokenfactory',
  calls: 2,
  reportedCalls: 2,
  inputTokens: 1800,
  outputTokens: 340,
  costUsd: 0.000846,
};

export const NANO_SUMMARY_EVENT: ModelUsageEvent = {
  ...SUPER_EVENT,
  id: 'evt_usage_summary',
  role: 'summarization',
  modelName: 'tokenfactory/nvidia-nemotron-3-nano-30b-a3b',
  modelId: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
  displayName: 'Nemotron 3 Nano',
  calls: 1,
  reportedCalls: 1,
  inputTokens: 500,
  outputTokens: 50,
  costUsd: 0.000042,
};

export const NANO_COMPACTION_EVENT: ModelUsageEvent = {
  ...NANO_SUMMARY_EVENT,
  id: 'evt_usage_compaction',
  role: 'compaction',
  inputTokens: 4000,
  outputTokens: 300,
  costUsd: 0.000312,
};
