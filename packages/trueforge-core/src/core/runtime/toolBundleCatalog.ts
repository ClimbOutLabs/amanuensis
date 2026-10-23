/** Built-in tool bundles, in the order the guidance index lists them. */
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
  /** The bundle's one line in the guidance index: what its guidance covers. */
  summary: string;
  /** Other names a model may use for the bundle; each reads it as the name itself would. */
  aliases: readonly string[];
}

const TOOL_BUNDLES: Record<ToolBundleName, ToolBundleSpec> = {
  google: {
    summary: 'email and calendar',
    aliases: ['gmail', 'email', 'mail', 'calendar', 'events'],
  },
  web: {
    summary: 'finding and citing sources; never state a current fact or a URL you have not read',
    aliases: ['search', 'internet', 'browse', 'fetch'],
  },
  maps: {
    summary: 'places, routes and maps',
    aliases: ['map', 'places', 'route', 'directions'],
  },
  sandbox: {
    summary: 'the sandbox workspace, repository work, file uploads',
    aliases: ['code', 'shell', 'run', 'exec'],
  },
  spaces: {
    summary: 'building and updating spaces, html layout classes',
    aliases: ['space', 'notes', 'docs'],
  },
  documents: {
    summary: 'attached files, document reports, net worth citations',
    aliases: ['document', 'attachments', 'reports'],
  },
  schedules: {
    summary: 'what schedules can and cannot do',
    aliases: ['schedule', 'recurring', 'automations'],
  },
  sub_agents: {
    summary: 'when and how to hand work to a helper',
    aliases: ['sub-agents', 'subagents', 'helpers', 'agents'],
  },
  extras: {
    summary: 'interactive answers (openui)',
    aliases: ['money', 'net_worth', 'usage', 'openui'],
  },
};

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
