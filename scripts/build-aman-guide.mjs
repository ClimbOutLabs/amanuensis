#!/usr/bin/env node
// Builds the built-in Aman guide knowledge pack. Run by `pnpm guide:build`.
//
// Topic pages are plain-words prose in packages/trueforge/guide/topics. The
// Tour cards in AmanTour.tsx are the source of truth for what Aman offers, so
// the build fails when a card has no page or a page names a card that does not
// exist. Output is a generated TypeScript module; do not edit it by hand.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import prettier from 'prettier';
import ts from 'typescript';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class AmanGuideBuildError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'AmanGuideBuildError';
  }
}

function defaultPaths(repoRoot) {
  return {
    tourPath: path.join(repoRoot, 'packages/trueforge-ui/src/components/AmanTour.tsx'),
    topicsDir: path.join(repoRoot, 'packages/trueforge/guide/topics'),
    outPath: path.join(repoRoot, 'packages/trueforge/src/personas/amanGuide/knowledgePack.generated.ts'),
  };
}

function literalText(node, where) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  throw new AmanGuideBuildError(`${where} must be a plain string.`);
}

function propertyMap(objectLiteral) {
  const values = new Map();
  for (const property of objectLiteral.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      values.set(property.name.text, property.initializer);
    }
  }
  return values;
}

/** Reads the Tour card arrays and the TourCapabilities type straight from source, without running the UI. */
function readTour(source, fileName) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const capabilityKeys = new Set();
  const cards = new Map();
  for (const statement of file.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === 'TourCapabilities') {
      for (const member of statement.type.members) {
        if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
          capabilityKeys.add(member.name.text);
        }
      }
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      const name = declaration.name.getText(file);
      if (!['TRY_A_DAY_PROMPTS', 'CAPABILITY_PROMPTS'].includes(name)) {
        continue;
      }
      if (!declaration.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) {
        throw new AmanGuideBuildError(`${name} must be an array literal.`);
      }
      for (const element of declaration.initializer.elements) {
        if (!ts.isObjectLiteralExpression(element)) {
          throw new AmanGuideBuildError(`Every entry in ${name} must be an object literal.`);
        }
        const props = propertyMap(element);
        const key = literalText(props.get('key'), `${name} key`);
        const needs = props.has('needs') ? literalText(props.get('needs'), `Tour card "${key}" needs`) : null;
        if (cards.has(key)) {
          throw new AmanGuideBuildError(`Duplicate Tour card "${key}".`);
        }
        cards.set(key, { label: literalText(props.get('label'), `Tour card "${key}" label`), needs });
      }
    }
  }
  if (cards.size === 0) {
    throw new AmanGuideBuildError('No Tour cards found in AmanTour.tsx.');
  }
  for (const [key, card] of cards) {
    if (card.needs !== null && !capabilityKeys.has(card.needs)) {
      throw new AmanGuideBuildError(
        `Tour card "${key}" needs "${card.needs}", which TourCapabilities does not declare.`,
      );
    }
  }
  return { cards, capabilityKeys };
}

/** Parses the `---` front matter block: id, title and a comma list of Tour cards the page covers. */
function parseTopic(text, fileName) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (match === null) {
    throw new AmanGuideBuildError(`${fileName} must start with a front matter block between --- lines.`);
  }
  const fields = new Map();
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
  }
  const id = fields.get('id') ?? '';
  const title = fields.get('title') ?? '';
  if (id === '' || title === '') {
    throw new AmanGuideBuildError(`${fileName} needs an id and a title.`);
  }
  const covers = (fields.get('covers') ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0);
  const body = match[2].trim();
  if (body === '') {
    throw new AmanGuideBuildError(`Guide topic "${id}" has an empty body.`);
  }
  return { id, title, covers, body };
}

async function readTopics(topicsDir) {
  const names = (await readdir(topicsDir)).filter(name => name.endsWith('.md')).sort();
  const topics = [];
  for (const name of names) {
    topics.push(parseTopic(await readFile(path.join(topicsDir, name), 'utf8'), name));
  }
  return topics;
}

/** Fails loudly on any gap between the Tour cards and the guide pages. */
function checkTopics({ topics, cards }) {
  const ids = new Set();
  for (const topic of topics) {
    if (ids.has(topic.id)) {
      throw new AmanGuideBuildError(`Duplicate guide topic id "${topic.id}".`);
    }
    ids.add(topic.id);
    for (const key of topic.covers) {
      if (!cards.has(key)) {
        throw new AmanGuideBuildError(`Guide topic "${topic.id}" names "${key}", which is not a Tour card.`);
      }
    }
  }
  const covered = new Set(topics.flatMap(topic => topic.covers));
  for (const key of cards.keys()) {
    if (!covered.has(key)) {
      throw new AmanGuideBuildError(`Tour card "${key}" has no guide entry. Add it to a page's covers list.`);
    }
  }
}

async function render({ topics, repoRoot, outPath }) {
  const entries = topics.map(
    topic =>
      `  { id: ${JSON.stringify(topic.id)}, title: ${JSON.stringify(topic.title)}, covers: ${JSON.stringify(topic.covers)}, body: ${JSON.stringify(topic.body)} },`,
  );
  const source = [
    '// Generated by scripts/build-aman-guide.mjs from packages/trueforge/guide/topics and the Tour cards. Do not edit by hand.',
    "import type { AmanGuideTopic } from './topic';",
    '',
    'export const AMAN_GUIDE_TOPICS: readonly AmanGuideTopic[] = [',
    ...entries,
    '];',
    '',
  ].join('\n');
  const config = (await prettier.resolveConfig(path.join(repoRoot, 'package.json'))) ?? {};
  return prettier.format(source, { ...config, parser: 'typescript', filepath: outPath });
}

/**
 * Builds the pack and writes the generated module. Throws AmanGuideBuildError
 * on any gap; the CLI turns that into a non-zero exit.
 */
export async function buildAmanGuide(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const paths = { ...defaultPaths(repoRoot), ...pickDefined(options) };
  const tour = readTour(await readFile(paths.tourPath, 'utf8'), paths.tourPath);
  const topics = await readTopics(paths.topicsDir);
  checkTopics({ topics, cards: tour.cards });
  const output = await render({ topics, repoRoot, outPath: paths.outPath });
  await mkdir(path.dirname(paths.outPath), { recursive: true });
  await writeFile(paths.outPath, output);
  return {
    outPath: paths.outPath,
    topics: topics.map(({ id, covers }) => ({ id, covers })),
    tourKeys: [...tour.cards.keys()],
  };
}

function pickDefined(options) {
  return Object.fromEntries(
    ['tourPath', 'topicsDir', 'outPath'].filter(key => options[key] !== undefined).map(key => [key, options[key]]),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildAmanGuide()
    .then(result => {
      console.log(`Aman guide: ${result.topics.length} pages, ${result.tourKeys.length} Tour cards covered.`);
      console.log(`Wrote ${path.relative(process.cwd(), result.outPath)}`);
    })
    .catch(error => {
      console.error(error instanceof AmanGuideBuildError ? error.message : error);
      process.exitCode = 1;
    });
}
