/** Built-in tool bundles, in the order the router adds the ones it picks together. */
export const TOOL_BUNDLE_NAMES = [
  'google',
  'web',
  'maps',
  'sandbox',
  'spaces',
  'documents',
  'schedules',
  'sub_agents',
  'extras',
] as const;

export type ToolBundleName = (typeof TOOL_BUNDLE_NAMES)[number];

interface ToolBundleSpec {
  /** The bundle's one line in the index: what its tools do, not their names. */
  summary: string;
  /** Other names a model may use for the bundle; each loads it as the name itself would. */
  aliases: readonly string[];
  /** Rules on the person's message that load the bundle before the first model call. Empty: loaded only on request. */
  routes: readonly RegExp[];
}

// Over-include when unsure: a bundle sent by mistake costs tokens, a bundle missing costs a step.
const TOOL_BUNDLES: Record<ToolBundleName, ToolBundleSpec> = {
  google: {
    summary: 'email: read, draft, send; calendar: add, change, list events',
    aliases: ['gmail', 'email', 'mail', 'calendar', 'events'],
    routes: [
      /\b(remind\w*|meeting\w*|meet|calendar\w*|events?|appointment\w*|invit\w*|rsvp|agenda|reschedul\w*|e-?mail\w*|mails?|inbox|gmail|repl(y|ies|ied)|drafts?|send|sent|unread|thread|attendees?|busy|free at|am i free|do i have|my day|today|tonight|tomorrow|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    ],
  },
  web: {
    summary: 'search the web, read web pages',
    aliases: ['search', 'internet', 'browse', 'fetch'],
    routes: [
      /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|org|net|io|dev|ai|co|gov|edu|uk|de|fr|pt|es|it|nl)\b/i,
      /\b(search\w*|look(ing)? up|lookup|google|find out|news|weather|forecast|prices?|costs?|hours|opening|website|web|online|articles?|reviews?|wiki\w*|recipes?|scores?|stocks?|flights?|who|what (is|was|are|were)|when (is|was|does|did)|how (much|many|old|long|far))\b/i,
      /\?\s*$/,
    ],
  },
  maps: {
    summary: 'show places, routes and maps',
    aliases: ['map', 'places', 'route', 'directions'],
    routes: [
      /\b(where|routes?|directions?|near|nearby|maps?|distance|how far|drive|driving|walk(ing)?|commute|address\w*|locat\w*|places?|restaurants?|caf[eé]s?|bars?|hotels?|museums?|airports?|stations?|parks?|beach\w*)\b/i,
    ],
  },
  sandbox: {
    summary: 'run code and commands, read and write files',
    aliases: ['code', 'shell', 'run', 'exec'],
    routes: [
      /\b(run|running|scripts?|files?|code|coding|python|javascript|typescript|program\w*|bash|shell|terminal|commands?|csv|xlsx|excel|spreadsheets?|json|charts?|plot\w*|graphs?|calculat\w*|comput\w*|convert\w*|zip|download\w*|repo\w*|git|github|clone|debug\w*|compil\w*|install\w*|analy[sz]\w*)\b/i,
    ],
  },
  spaces: {
    summary: "create, read and change the person's spaces (notes, lists, documents)",
    aliases: ['space', 'notes', 'docs'],
    routes: [
      /\b(docs?|spaces?|notes?|notebook|checklists?|journal|pages?|write (it|this|that) down|keep track|(shopping|grocery|packing|reading|to-?do) lists?)\b/i,
    ],
  },
  documents: {
    summary: 'read attached files, make document reports',
    aliases: ['document', 'attachments', 'reports'],
    routes: [],
  },
  schedules: {
    summary: 'repeat a task on a schedule: create, list, pause, resume, delete',
    aliases: ['schedule', 'recurring', 'automations'],
    routes: [
      /\b(every|daily|weekly|monthly|hourly|each (day|week|month|morning|evening|night)|schedul\w*|recurring|repeat\w*|routine|automat\w*|at \d{1,2}(:\d{2})?|\d{1,2}(:\d{2})?\s*(am|pm))\b/i,
    ],
  },
  sub_agents: {
    summary: 'hand a task to a helper that works on it separately',
    aliases: ['sub-agents', 'subagents', 'helpers', 'agents'],
    routes: [
      /\b(research|in parallel|deep dive|investigat\w*|compare|comparison|thorough\w*|delegat\w*|sub-?agents?|helpers?)\b/i,
    ],
  },
  extras: {
    summary: 'net worth summary, usage and cost summary, interactive answers (openui)',
    aliases: ['money', 'net_worth', 'usage', 'openui'],
    routes: [],
  },
};

/** What the router reads besides the message itself. */
export interface BundleRouteSignals {
  /** The message carries attached files. */
  attachments: boolean;
  /** The chat is bound to a repository. */
  repositoryAttached: boolean;
}

/** The bundles a person's message calls for, before the model has seen it. */
export function routeBundles(input: { message: string; signals: BundleRouteSignals }): Set<ToolBundleName> {
  const routed = new Set(
    TOOL_BUNDLE_NAMES.filter(name => TOOL_BUNDLES[name].routes.some(rule => rule.test(input.message))),
  );
  if (input.signals.attachments) {
    routed.add('documents');
  }
  if (input.signals.repositoryAttached) {
    routed.add('sandbox');
  }
  return routed;
}

/** One line per bundle for the index the model reads. */
export function bundleIndexLine(name: ToolBundleName): string {
  return `- ${name}: ${TOOL_BUNDLES[name].summary}`;
}

function normalize(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function editDistance(input: { from: string; to: string }): number {
  let previous = Array.from({ length: input.to.length + 1 }, (_, i) => i);
  for (let i = 1; i <= input.from.length; i++) {
    const current = [i];
    for (let j = 1; j <= input.to.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (input.from[i - 1] === input.to[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[input.to.length] ?? 0;
}

export type BundleLookup = { found: ToolBundleName } | { closest: ToolBundleName | undefined };

/** The bundle a name or alias means among `offered`, or the closest one when it means none. */
export function findBundle(input: { name: string; offered: readonly ToolBundleName[] }): BundleLookup {
  const wanted = normalize(input.name);
  const candidates = input.offered.flatMap(name =>
    [name, ...TOOL_BUNDLES[name].aliases].map(word => ({ name, word: normalize(word) })),
  );
  const exact = candidates.find(candidate => candidate.word === wanted);
  if (exact !== undefined) {
    return { found: exact.name };
  }
  const ranked = candidates
    .map(candidate => ({ ...candidate, distance: editDistance({ from: wanted, to: candidate.word }) }))
    .sort((a, b) => a.distance - b.distance);
  return { closest: ranked[0]?.name };
}
