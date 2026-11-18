/**
 * Goals as the screens draw them. The server owns the wire shape (the goal
 * schemas in the host); the host's API layer checks every body and hands these
 * shapes over, so a goal this version does not recognise is never drawn wrong.
 */

/** Where a goal stands for good: being drafted, running, held, or finished one way or the other. */
export type GoalLifecycle = 'draft' | 'active' | 'paused' | 'completed' | 'ended';

/** Where one step of the plan stands. */
export type GoalStepStatus =
  | 'planned'
  | 'ready'
  | 'in_progress'
  | 'waiting_for_approval'
  | 'awaiting_verification'
  | 'verified'
  | 'owner_confirmed'
  | 'failed'
  | 'outcome_unknown';

/** The kinds of source a goal may read. */
export type GoalSourceKind = 'space' | 'document' | 'mail' | 'calendar' | 'web' | 'manual';

/** One source the owner picked for the goal. Only these are read into a check. */
export type GoalSourceRef = {
  sourceKind: GoalSourceKind;
  /** The source's own identifier, such as a space id. */
  sourceRef: string;
  /** What the owner calls this source. */
  label: string;
};

/** The work limits a goal runs under, as set on its activation card. */
export type GoalExecutionPolicy = {
  /** Routine checks per day. One is the default; more is an explicit choice on the card. */
  checksPerDay: number;
  /** Longest time one check may work, in minutes. */
  cycleMinutes: number;
  /** Model calls one check may make at most. */
  modelCallLimit: number;
  /** Tool calls one check may make at most. */
  toolCallLimit: number;
  /** Tokens one check may use at most. */
  cycleTokenLimit: number;
  /** Tokens this goal may use per day across all its checks. */
  dailyTokenAllowance: number;
};

/** How updates about a goal reach the owner. */
export type GoalNotificationPolicy = {
  /** True when updates arrive as one short digest instead of one message per event. */
  digest: boolean;
};

/** The agent setup an activation pinned, in the short form the card and the goal page show. */
export type GoalSetupSummary = {
  agentId: string;
  agentName: string;
  /** The saved agent's version stamp at activation, when it has one. */
  agentVersion: string | null;
  /** The model the setup runs, by its full name. */
  modelName: string;
  /** Connected tool servers the setup uses, by name. */
  mcpServerNames: string[];
  /** Skills the setup carries, by name. */
  skillNames: string[];
  /** Digest of the whole setup, used to spot a setup that changed after review. */
  digest: string;
  /** ISO 8601 time the setup was pinned. */
  pinnedAt: string;
};

/** One goal, as the list and the goal page draw it. */
export type GoalItem = {
  goalId: string;
  title: string;
  outcome: string;
  successCriteria: string[];
  /** ISO 8601 target time, or null when the goal has no date. */
  targetAt: string | null;
  /** The IANA time zone the goal's dates and daily allowance are read in. */
  timezone: string;
  lifecycle: GoalLifecycle;
  /** The revision every change is checked against. */
  revision: number;
  agentId: string | null;
  selectedSources: GoalSourceRef[];
  executionPolicy: GoalExecutionPolicy;
  notificationPolicy: GoalNotificationPolicy;
  /** A Space linked as a view of the plan, or null. The link grants nothing. */
  linkedSpaceId: string | null;
  pinnedSetup: GoalSetupSummary | null;
  /** ISO 8601 time of the next routine check, or null when none is due. */
  nextCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** One step of a goal's plan. */
export type GoalStep = {
  stepId: string;
  goalId: string;
  description: string;
  /** Step ids this step waits on. */
  dependsOn: string[];
  status: GoalStepStatus;
  acceptanceCriteria: string;
  /** Source references this step listens to. */
  sourceRefs: string[];
  /** Evidence recorded for this step. */
  evidenceIds: string[];
  /** The action this step waits on, when one was proposed. */
  actionId: string | null;
};

/** A goal with its plan and the step work turns to next. */
export type GoalDetail = {
  goal: GoalItem;
  steps: GoalStep[];
  nextStepId: string | null;
};

/** One piece of evidence a check recorded for a goal. */
export type GoalEvidence = {
  evidenceId: string;
  goalId: string;
  cycleId: string | null;
  sourceKind: GoalSourceKind;
  sourceRef: string;
  sourceRevision: string;
  /** ISO 8601 time the evidence was seen. */
  observedAt: string;
  /** ISO 8601 time the source says the thing happened, when it says one. */
  claimedEventAt: string | null;
  freshness: string;
  admission: string;
  extractionMethod: string;
  /** The short excerpt kept with the evidence. */
  excerpt: string;
};

/** One entry in a goal's history: what changed, in the order it happened. */
export type GoalEvent = {
  eventId: string;
  goalId: string;
  sequence: number;
  eventType: string;
  actor: string;
  payload: Readonly<Record<string, unknown>>;
  createdAt: string;
};

/** One decision still waiting for the owner on a goal. */
export type GoalApproval = {
  actionId: string;
  goalId: string;
  cycleId: string | null;
  expectedRevision: number;
  toolCallRef: string | null;
  approvalRef: string | null;
  executionState: string;
  receiptRef: string | null;
  createdAt: string;
};

/** How one check ended. */
export type GoalCycleOutcome = 'completed' | 'nothing_changed' | 'needs_decision' | 'budget_exhausted' | 'failed';

/** One run of a goal check. */
export type GoalCycle = {
  cycleId: string;
  goalId: string;
  inputRevision: number;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: GoalCycleOutcome | null;
  outcomeDetail: string | null;
  sessionId: string | null;
  nextCheckAt: string | null;
};

/** What one Check now run recorded. */
export type GoalCheckResult = {
  cycle: GoalCycle;
  goal: GoalItem;
  steps: GoalStep[];
  newEvidence: GoalEvidence[];
  /** Selected sources the check could not read. */
  unreadSources: GoalSourceRef[];
  nextStepId: string | null;
};

/** What the activation card shows: the goal, its plan, and the setup resolved right now. */
export type GoalActivationPreview = {
  goal: GoalItem;
  steps: GoalStep[];
  setup: GoalSetupSummary;
};

/** A saved agent the person can put on a goal. */
export type GoalAgentOption = {
  id: string;
  name: string;
};

/** One step as the person writes it in the new goal form. Dependencies name earlier steps by position. */
export type CreateGoalStepInput = {
  description: string;
  dependsOnIndexes: number[];
  acceptanceCriteria: string;
  sourceRefs: string[];
};

/** What the new goal form sends. */
export type CreateGoalInput = {
  agentId: string | null;
  title: string;
  outcome: string;
  successCriteria: string[];
  targetAt: string | null;
  timezone: string;
  selectedSources: GoalSourceRef[];
  steps: CreateGoalStepInput[];
  executionPolicy?: GoalExecutionPolicy;
  notificationPolicy?: GoalNotificationPolicy;
  linkedSpaceId?: string | null;
};

/** An edit to a goal, checked against the revision the person read. */
export type UpdateGoalInput = {
  expectedRevision: number;
  /** The agent who will do the work, or null to clear it. A draft may gain or change its agent here. */
  agentId?: string | null;
  title?: string;
  outcome?: string;
  successCriteria?: string[];
  targetAt?: string | null;
  timezone?: string;
  selectedSources?: GoalSourceRef[];
  executionPolicy?: GoalExecutionPolicy;
  notificationPolicy?: GoalNotificationPolicy;
  linkedSpaceId?: string | null;
};

/**
 * Activation or a check was refused because the agent setup changed after the
 * card was reviewed. Carries the updated card, so the screen can show it
 * instead of activating against a setup the owner never saw.
 */
export class GoalSetupChangedError extends Error {
  readonly preview: GoalActivationPreview;

  constructor(message: string, preview: GoalActivationPreview) {
    super(message);
    this.name = 'GoalSetupChangedError';
    this.preview = preview;
  }
}

/** The goals service, served by the host. Every method rejects with a message fit to show. */
export type GoalsApi = {
  /** Every goal the person has, newest first. */
  listGoals(): Promise<GoalItem[]>;
  /** One goal with its plan. */
  getGoal(goalId: string): Promise<GoalDetail>;
  /** Creates a goal in draft. Nothing is checked until the owner reviews the card and activates it. */
  createGoal(input: CreateGoalInput): Promise<GoalDetail>;
  /** Saves an edit checked against the revision the person read. */
  updateGoal(goalId: string, input: UpdateGoalInput): Promise<GoalDetail>;
  /** What the activation card shows for a goal right now. */
  getActivationPreview(goalId: string): Promise<GoalActivationPreview>;
  /**
   * Activates a goal against the setup digest the card showed. Rejects with a
   * GoalSetupChangedError carrying the updated card when the setup moved.
   */
  activateGoal(goalId: string, input: { expectedRevision: number; setupDigest: string }): Promise<GoalDetail>;
  /** Pauses an active goal. Its waiting approvals are invalidated. */
  pauseGoal(goalId: string, expectedRevision: number): Promise<GoalDetail>;
  /** Resumes a paused goal. */
  resumeGoal(goalId: string, expectedRevision: number): Promise<GoalDetail>;
  /** Ends a goal. Its history is kept for reference. */
  endGoal(goalId: string, expectedRevision: number): Promise<GoalDetail>;
  /** Runs one check now and reports what it recorded. */
  checkGoal(goalId: string): Promise<GoalCheckResult>;
  /** The evidence recorded for a goal, newest first. */
  listEvidence(goalId: string): Promise<GoalEvidence[]>;
  /** What changed on a goal, in the order it happened. */
  listEvents(goalId: string): Promise<GoalEvent[]>;
  /** The decisions still waiting for the owner on a goal, oldest first. */
  listApprovals(goalId: string): Promise<GoalApproval[]>;
  /** The saved agents a goal can be given to. */
  listAgents(): Promise<GoalAgentOption[]>;
};
