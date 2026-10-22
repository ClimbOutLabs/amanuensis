import type { AgentInfo, AgentParent } from '../events/schema';
import type { TurnToolCallLedger } from '../mcp/executeToolCalls';
import type { AgentDefinition } from './AgentDefinition';
import type { AgentThread } from './AgentThread';

export type CreateDynamicSubAgentThread = (input: {
  parentDefinition: AgentDefinition;
  /** The starting thread's turn ledger, so the sub-agent's calls count toward the same turn. */
  turnToolCallLedger: TurnToolCallLedger;
  request: AgentInfo;
  threadId: string;
  parent: AgentParent;
  signal: AbortSignal;
}) => Promise<AgentThread>;
