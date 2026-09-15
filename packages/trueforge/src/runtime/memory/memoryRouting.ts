/**
 * Decides, from the newest user message alone, whether a turn also asks for the provider's
 * reflect layer.
 *
 * Recall (facts, no model call) runs on every turn. Reflect is the provider's agentic synthesis
 * over mental models, observations and raw facts; it spends model calls on the same local server
 * that serves chat, so it runs only when the message is shaped like a request for a conclusion
 * rather than a fact: an ask to summarize, brief, recommend, compare, assess, or say what should be
 * done. A factual lookup such as "how much tax did I pay in 2025" stays on recall.
 *
 * The patterns encode the shape of the request, not keywords: "give me a summary of X" fires,
 * "is the summary email in my inbox" does not; "compare my 2024 and 2025 bills" fires, "did I
 * compare prices" does not. Every pattern in the list has a factual counterexample in its tests,
 * so an addition that would widen model-call frequency has to say so. The one that fired is
 * recorded on the turn's `aman.memory.recall` event, so a routing decision is explainable from the
 * event alone.
 */
export type MemoryRoute = 'recall' | 'reflect';

export interface MemoryRouteDecision {
  route: MemoryRoute;
  /** Source of the synthesis pattern that selected reflect; absent when the route is recall. */
  matched?: string;
}

const SYNTHESIS_PATTERNS: readonly RegExp[] = [
  // An ask for a course of action.
  /\bwhat should (?:i|we) do\b/i,
  /\bwhat (?:do|would) you (?:recommend|suggest|advise)\b/i,
  /\b(?:can|could|would) you (?:recommend|suggest|advise)\b/i,
  // An ask for a digest.
  /\bsummari[sz]e\b/i,
  /\b(?:give|send|write|get)(?: me)? (?:a |an |the |your )?(?:quick |short |brief |full |overall )?(?:summary|overview|briefing|rundown|recap|assessment|recommendation)\b/i,
  /\bbrief me\b/i,
  /\b(?:your|an|the|my) (?:overall )?(?:assessment|take|read|view) (?:on|of)\b/i,
  // An ask to weigh things against each other.
  /\bcompare (?:my|our|the|these|those|both|it|them)\b/i,
  /\b(?:assess|evaluate|analy[sz]e) (?:my|our|the|whether|how|if|this|these)\b/i,
  // An ask about the state of knowledge or progress.
  /\bwhat have (?:i|we|you) learned\b/i,
  /\bwhat do (?:you|we) know about\b/i,
  /\bhow am i doing\b/i,
];

export function decideMemoryRoute(newestUserMessage: string | undefined): MemoryRouteDecision {
  if (newestUserMessage === undefined) {
    return { route: 'recall' };
  }
  for (const pattern of SYNTHESIS_PATTERNS) {
    if (pattern.test(newestUserMessage)) {
      return { route: 'reflect', matched: pattern.source };
    }
  }
  return { route: 'recall' };
}
