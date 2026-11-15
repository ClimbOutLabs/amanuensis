#!/usr/bin/env node
// Checks that every surface a person can reach has a help topic. Run by `pnpm test:help-coverage`.
//
// The surfaces are read from the code: the Settings panels, the email and calendar presets, the Tour
// cards, the Home pills, the approval card kinds, the installer's commands and the server's route
// groups. A topic names the surfaces it explains in its `covers` list as `kind:name`; Tour cards stay
// bare keys. guide/coverage.json holds the mappings that cannot live with a topic (such as a docs
// page's entry in the pack), the exemptions, each with a one-line reason, and the fixed "stuck"
// questions the nightly run asks the help button.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isTourCardCover, readDocs, readTopics, readTour } from './build-aman-guide.mjs';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const NO_TOPIC_NEXT_STEP =
  'Write a topic in packages/trueforge/guide/topics that covers it, or mark it exempt with a reason.';

export class HelpCoverageError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'HelpCoverageError';
  }
}

/** Where each surface is read from, relative to the repository root. Tests point these at fixtures. */
export function defaultSources(repoRoot) {
  const at = relative => path.join(repoRoot, relative);
  return {
    settingsPath: at('packages/trueforge-ui/src/containers/SettingsBuilder/index.tsx'),
    emailPresetsPath: at('packages/trueforge-core/src/core/email/mailConnector/presets.ts'),
    calendarPresetsPath: at('packages/trueforge-core/src/core/calendar/caldav/presets.ts'),
    tourPath: at('packages/trueforge-ui/src/components/tourPrompts.ts'),
    approvalTypesPath: at('packages/trueforge-ui/src/sentinel/types.ts'),
    installerCliPath: at('packages/aman-installer/src/cli.ts'),
    installerShellPath: at('installer/doctor/aman'),
    routesDir: at('packages/trueforge/src/routes'),
    topicsDir: at('packages/trueforge/guide/topics'),
    docsDir: at('docs'),
    coveragePath: at('packages/trueforge/guide/coverage.json'),
  };
}

/** The Settings panels as the tab strip lists them: `{ id, label }` in tab order. */
export function readSettingsPanels(source) {
  const panels = [...source.matchAll(/\{\s*id:\s*'([a-z][a-z-]*)',\s*label:\s*'([^']+)',\s*icon:/g)].map(match => ({
    id: match[1],
    label: match[2],
  }));
  if (panels.length === 0) {
    throw new HelpCoverageError(
      'No Settings panels found in SettingsBuilder/index.tsx. Keep each tab written as { id, label, icon }.',
    );
  }
  return panels;
}

/** The `key` of every entry in the named preset table. Constant keys are resolved from the same file. */
function readPresetKeys({ source, tableName, fileName }) {
  const start = source.indexOf(`export const ${tableName}`);
  if (start === -1) {
    throw new HelpCoverageError(
      `${fileName} no longer exports ${tableName}. Point check-help-coverage.mjs at the table.`,
    );
  }
  const constants = new Map(
    [...source.matchAll(/export const ([A-Z][A-Z0-9_]*) = '([^']+)';/g)].map(match => [match[1], match[2]]),
  );
  const table = source.slice(start, source.indexOf('\n];', start));
  const keys = [];
  for (const match of table.matchAll(/\n {4}key: (?:'([^']+)'|([A-Z][A-Z0-9_]*)),/g)) {
    const key = match[1] ?? constants.get(match[2]);
    if (key === undefined) {
      throw new HelpCoverageError(`${fileName}: the key ${match[2]} in ${tableName} is not a string constant.`);
    }
    keys.push(key);
  }
  return keys;
}

/** The Home pills, in the order HOME_TOPIC_IDS lists them. */
function readPills(source) {
  const match = /export const HOME_TOPIC_IDS = \[([\s\S]*?)\]/.exec(source);
  if (match === null) {
    throw new HelpCoverageError(
      'tourPrompts.ts no longer exports HOME_TOPIC_IDS. Point check-help-coverage.mjs at the pills.',
    );
  }
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map(item => item[1]);
}

/**
 * The approval card kinds: each detail field of SentinelApprovalCard that carries a whole message,
 * event, schedule or persona, plus the plain card every other action shows.
 */
function readApprovalKinds(source) {
  const start = source.indexOf('export type SentinelApprovalCard = {');
  if (start === -1) {
    throw new HelpCoverageError(
      'sentinel/types.ts no longer defines SentinelApprovalCard. Point check-help-coverage.mjs at it.',
    );
  }
  const body = source.slice(start, source.indexOf('\n};', start));
  const kinds = [...body.matchAll(/\n {2}([a-z_]+): SentinelApproval[A-Za-z]+ \| null;/g)].map(match => match[1]);
  return ['plain', ...kinds];
}

/**
 * The commands a person can type after `aman`: every command the installer program dispatches,
 * and every command the `aman` script on Mac and Linux dispatches.
 */
export function readInstallerCommands({ cliSource, shellSource }) {
  const commands = new Set();
  for (const match of cliSource.matchAll(/first === '([a-z][a-z-]*)'/g)) {
    commands.add(match[1]);
  }
  const main = shellSource.slice(
    shellSource.indexOf('# ---------------------------------------------------------------- main'),
  );
  const dispatch = main
    .split('case "${1:-}" in')
    .map(block => block.slice(0, block.indexOf('\nesac')))
    .find(block => block.includes('Unknown command'));
  if (commands.size === 0 || dispatch === undefined) {
    throw new HelpCoverageError(
      'No installer commands found. Keep the commands dispatched as `first === ...` in cli.ts and in the case block of installer/doctor/aman.',
    );
  }
  for (const match of dispatch.matchAll(/\n\s+([a-z][a-z| -]*)\)/g)) {
    for (const name of match[1].split('|')) {
      commands.add(name.trim());
    }
  }
  return commands;
}

/** Each `<name>Routes.ts` file is one route group. */
async function readRouteGroups(routesDir) {
  return (await readdir(routesDir))
    .filter(name => name.endsWith('Routes.ts'))
    .map(name => name.slice(0, -'Routes.ts'.length))
    .sort();
}

/** Every surface, as `kind:name` ids with the place it was read from. */
export async function readSurfaces(sources) {
  const read = file => readFile(file, 'utf8');
  const [settings, email, calendar, tour, approvals, cli, shell] = await Promise.all([
    read(sources.settingsPath),
    read(sources.emailPresetsPath),
    read(sources.calendarPresetsPath),
    read(sources.tourPath),
    read(sources.approvalTypesPath),
    read(sources.installerCliPath),
    read(sources.installerShellPath),
  ]);
  const surfaces = [
    ...readSettingsPanels(settings).map(panel => `settings:${panel.id}`),
    ...readPresetKeys({ source: email, tableName: 'EMAIL_PROVIDER_PRESETS', fileName: 'mailConnector/presets.ts' }).map(
      key => `email-preset:${key}`,
    ),
    ...readPresetKeys({ source: calendar, tableName: 'CALDAV_PROVIDER_PRESETS', fileName: 'caldav/presets.ts' }).map(
      key => `calendar-preset:${key}`,
    ),
    ...[...readTour(tour, sources.tourPath).cards.keys()].map(key => `tour:${key}`),
    ...readPills(tour).map(id => `pill:${id}`),
    ...readApprovalKinds(approvals).map(kind => `approval:${kind}`),
    ...[...readInstallerCommands({ cliSource: cli, shellSource: shell })].sort().map(name => `command:${name}`),
    ...(await readRouteGroups(sources.routesDir)).map(name => `route:${name}`),
  ];
  return [...new Set(surfaces)];
}

function isStringRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(item => typeof item === 'string')
  );
}

function isTopicListRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(item => Array.isArray(item) && item.every(id => typeof id === 'string'))
  );
}

/** coverage.json: `covers` (surface to topic ids), `exempt` (surface to reason) and `questions`. */
export async function readCoverageFile(coveragePath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(coveragePath, 'utf8'));
  } catch (error) {
    throw new HelpCoverageError(`${coveragePath} must be JSON with covers, exempt and questions.`, { cause: error });
  }
  const covers = parsed?.covers ?? {};
  const exempt = parsed?.exempt ?? {};
  const questions = parsed?.questions ?? [];
  if (
    !isTopicListRecord(covers) ||
    !isStringRecord(exempt) ||
    !Array.isArray(questions) ||
    !questions.every(item => typeof item?.question === 'string' && typeof item?.topic === 'string')
  ) {
    throw new HelpCoverageError(
      `${coveragePath} must hold covers as { surface: [topic ids] }, exempt as { surface: reason } and questions as [{ question, topic }].`,
    );
  }
  return { covers, exempt, questions };
}

/** The surface id a topic's cover names: Tour cards are bare keys, everything else is `kind:name`. */
function surfaceOfCover(cover) {
  return isTourCardCover(cover) ? `tour:${cover}` : cover;
}

/**
 * Every problem as one plain line. An empty list means every surface has a topic or a reasoned
 * exemption, every row names a real surface and topic, and every question maps to a topic.
 */
export async function checkHelpCoverage(sources) {
  const surfaces = await readSurfaces(sources);
  const known = new Set(surfaces);
  const topics = await readTopics(sources.topicsDir);
  // A docs page is in the pack too, so coverage.json may map a surface to its entry id.
  const docsEntries = await readDocs(sources.docsDir);
  const topicIds = new Set([...topics, ...docsEntries].map(topic => topic.id));
  const coverage = await readCoverageFile(sources.coveragePath);
  const problems = [];
  const coveredBy = new Map();
  const addCover = ({ surface, topicId, where }) => {
    if (!known.has(surface)) {
      problems.push(`${where} names "${surface}", which is not a surface any more. Remove it or fix the name.`);
      return;
    }
    if (!topicIds.has(topicId)) {
      problems.push(`${where} maps "${surface}" to "${topicId}", which is not a topic id. Fix the topic id.`);
      return;
    }
    coveredBy.set(surface, [...(coveredBy.get(surface) ?? []), topicId]);
  };
  for (const topic of topics) {
    for (const cover of topic.covers) {
      addCover({ surface: surfaceOfCover(cover), topicId: topic.id, where: `Topic "${topic.id}"` });
    }
  }
  for (const [surface, ids] of Object.entries(coverage.covers)) {
    for (const topicId of ids) {
      addCover({ surface, topicId, where: 'coverage.json covers' });
    }
  }
  for (const [surface, reason] of Object.entries(coverage.exempt)) {
    if (!known.has(surface)) {
      problems.push(`coverage.json exempts "${surface}", which is not a surface any more. Remove the row.`);
    } else if (reason.trim() === '') {
      problems.push(`coverage.json exempts "${surface}" with no reason. Add a one-line reason.`);
    } else if (coveredBy.has(surface)) {
      problems.push(`"${surface}" has a topic and an exemption. Remove the exemption from coverage.json.`);
    }
  }
  for (const surface of surfaces) {
    if (!coveredBy.has(surface) && coverage.exempt[surface] === undefined) {
      problems.push(`"${surface}" has no help topic. ${NO_TOPIC_NEXT_STEP}`);
    }
  }
  for (const { question, topic } of coverage.questions) {
    if (!topicIds.has(topic)) {
      problems.push(`The stuck question "${question}" maps to "${topic}", which is not a topic id. Map it to a topic.`);
    }
  }
  return { surfaces, problems };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkHelpCoverage(defaultSources(DEFAULT_REPO_ROOT))
    .then(({ surfaces, problems }) => {
      if (problems.length === 0) {
        console.log(`Help coverage: all ${String(surfaces.length)} surfaces have a topic or a reasoned exemption.`);
        return;
      }
      for (const problem of problems) {
        console.error(problem);
      }
      process.exitCode = 1;
    })
    .catch(error => {
      console.error(error instanceof HelpCoverageError ? error.message : error);
      process.exitCode = 1;
    });
}
