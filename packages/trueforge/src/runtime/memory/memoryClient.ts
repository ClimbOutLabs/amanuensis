/**
 * Backend-agnostic interface for the long-term memory provider Aman speaks to each turn.
 *
 * `HindsightClient` (REST API over a Hindsight bank) and `MarkdownMemoryClient` (local
 * Markdown files, OpenClaw-style) both implement this. Callers must depend on this
 * interface, never on a concrete client, so the backend selected by `MEMORY_BACKEND`
 * is a drop-in replacement.
 *
 * The contract mirrors `HindsightClient`'s: every method returns a discriminated `{ ok }`
 * result and never throws, so a memory failure degrades a turn instead of failing it.
 */
import type {
  GetOperationOutcome,
  GetProfileOutcome,
  ListMentalModelsOutcome,
  RecallOutcome,
  ReflectBudget,
  ReflectOutcome,
  RetainItem,
  RetainOutcome,
  RetryOperationOutcome,
} from './hindsightClient';

export interface MemoryClient {
  recall(params: {
    query: string;
    maxTokens: number;
    queryTimestamp: string;
    entityTokens: number;
    timeoutMs: number;
  }): Promise<RecallOutcome>;

  retain(params: { items: RetainItem[]; operationId: string; timeoutMs: number }): Promise<RetainOutcome>;

  getOperation(id: string, timeoutMs: number): Promise<GetOperationOutcome>;

  retryOperation(id: string, timeoutMs: number): Promise<RetryOperationOutcome>;

  getProfile(timeoutMs: number): Promise<GetProfileOutcome>;

  listMentalModels(params: { limit: number; timeoutMs: number }): Promise<ListMentalModelsOutcome>;

  reflect(params: {
    query: string;
    budget: ReflectBudget;
    maxTokens: number;
    timeoutMs: number;
  }): Promise<ReflectOutcome>;
}
