#!/usr/bin/env node
// Builds the built-in Aman guide knowledge pack. Run by `pnpm guide:build`.
//
// Topic pages are plain-words prose in packages/trueforge/guide/topics. The
// Tour cards in packages/trueforge-ui/src/components/tourPrompts.ts are the
// source of truth for what Aman offers. Cards listed in required-cards.json must
// have a page, or the build fails. Any other card without a page is a warning.
// Output is a generated TypeScript module; do not edit it by hand.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import prettier from 'prettier';
import ts from 'typescript';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The exported constants that hold every Tour card, in the order they are read.
const TOUR_CARD_EXPORTS = ['MORNING_BRIEF', 'GENERAL_DAY_PROMPTS', 'HELP_AREAS', 'CAPABILITY_PROMPTS'];

export class AmanGuideBuildError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'AmanGuideBuildError';
  }
}

function defaultPaths(repoRoot) {
  return {
    tourPath: path.join(repoRoot, 'packages/trueforge-ui/src/components/tourPrompts.ts'),
    topicsDir: path.join(repoRoot, 'packages/trueforge/guide/topics'),
    requiredCardsPath: path.join(repoRoot, 'packages/trueforge/guide/required-cards.json'),
    outPath: path.join(repoRoot, 'packages/trueforge/src/personas/amanGuide/knowledgePack.generated.ts'),
  };
}

function literalText(node, where) {
  if (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
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

/** Reads the Tour cards from tourPrompts.ts source, following the constants that hold them, without running the UI. */
function readTour(source, fileName) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const capabilityKeys = new Set();
  const declarations = new Map();
  const exported = new Set();
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
    const isExported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer === undefined) {
        continue;
      }
      const name = declaration.name.getText(file);
      declarations.set(name, declaration.initializer);
      if (isExported) {
        exported.add(name);
      }
    }
  }

  const cards = new Map();
  const resolving = new Set();

  function addCard(node) {
    const props = propertyMap(node);
    const key = literalText(props.get('key'), 'A Tour card key');
    const label = literalText(props.get('label'), `Tour card "${key}" label`);
    const needs = props.has('needs') ? capabilityList(props.get('needs'), `Tour card "${key}" needs`) : [];
    const existing = cards.get(key);
    if (existing !== undefined) {
      if (existing.node === node) {
        return;
      }
      throw new AmanGuideBuildError(`Duplicate Tour card "${key}".`);
    }
    for (const name of needs) {
      if (!capabilityKeys.has(name)) {
        throw new AmanGuideBuildError(`Tour card "${key}" needs "${name}", which TourCapabilities does not declare.`);
      }
    }
    cards.set(key, { node, label, needs });
  }

  // Walks a card list or help-area table, following names to the constants they point at.
  function collect(node, where) {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      const target = declarations.get(name);
      if (target === undefined) {
        throw new AmanGuideBuildError(`${where} uses "${name}", which tourPrompts.ts does not declare.`);
      }
      if (resolving.has(name)) {
        throw new AmanGuideBuildError(`"${name}" in tourPrompts.ts refers back to itself.`);
      }
      resolving.add(name);
      collect(target, where);
      resolving.delete(name);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        collect(element, where);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      if (propertyMap(node).has('key')) {
        addCard(node);
        return;
      }
      for (const value of propertyMap(node).values()) {
        if (ts.isIdentifier(value) || ts.isArrayLiteralExpression(value) || ts.isObjectLiteralExpression(value)) {
          collect(value, where);
        }
      }
    }
  }

  for (const name of TOUR_CARD_EXPORTS) {
    if (!exported.has(name)) {
      throw new AmanGuideBuildError(
        `tourPrompts.ts must export ${name}. The guide build reads the Tour cards from it.`,
      );
    }
    collect(declarations.get(name), name);
  }
  if (cards.size === 0) {
    throw new AmanGuideBuildError('No Tour cards found in tourPrompts.ts.');
  }
  return { cards, capabilityKeys };
}

function capabilityList(node, where) {
  if (!ts.isArrayLiteralExpression(node)) {
    throw new AmanGuideBuildError(`${where} must be a list of capability names.`);
  }
  return node.elements.map(element => literalText(element, where));
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

/** The Tour card keys that must have a guide page. The build fails if one of them does not. */
async function readRequiredCards(requiredCardsPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(requiredCardsPath, 'utf8'));
  } catch (error) {
    throw new AmanGuideBuildError(`${requiredCardsPath} must be a JSON list of Tour card keys.`, { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
    throw new AmanGuideBuildError(`${requiredCardsPath} must be a JSON list of Tour card keys.`);
  }
  return parsed;
}

/**
 * Fails on a broken page or a required card with no page. Returns the Tour cards
 * that have no page yet; those are warnings, not errors.
 */
function checkTopics({ topics, cards, requiredKeys }) {
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
  for (const key of requiredKeys) {
    if (!cards.has(key)) {
      throw new AmanGuideBuildError(`required-cards.json lists "${key}", which is not a Tour card.`);
    }
    if (!covered.has(key)) {
      throw new AmanGuideBuildError(`Tour card "${key}" must have a guide page. Add it to a page's covers list.`);
    }
  }
  return [...cards.keys()].filter(key => !covered.has(key));
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
 * on any gap that must be fixed; the CLI turns that into a non-zero exit.
 */
export async function buildAmanGuide(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const paths = { ...defaultPaths(repoRoot), ...pickDefined(options) };
  const tour = readTour(await readFile(paths.tourPath, 'utf8'), paths.tourPath);
  const topics = await readTopics(paths.topicsDir);
  const requiredKeys = await readRequiredCards(paths.requiredCardsPath);
  const uncoveredKeys = checkTopics({ topics, cards: tour.cards, requiredKeys });
  const output = await render({ topics, repoRoot, outPath: paths.outPath });
  await mkdir(path.dirname(paths.outPath), { recursive: true });
  await writeFile(paths.outPath, output);
  return {
    outPath: paths.outPath,
    topics: topics.map(({ id, covers }) => ({ id, covers })),
    tourKeys: [...tour.cards.keys()],
    uncoveredKeys,
  };
}

function pickDefined(options) {
  return Object.fromEntries(
    ['tourPath', 'topicsDir', 'requiredCardsPath', 'outPath']
      .filter(key => options[key] !== undefined)
      .map(key => [key, options[key]]),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildAmanGuide()
    .then(result => {
      console.log(`Aman guide: ${result.topics.length} pages, ${result.tourKeys.length} Tour cards.`);
      console.log(`Wrote ${path.relative(process.cwd(), result.outPath)}`);
      if (result.uncoveredKeys.length > 0) {
        console.warn(
          `Warning: ${result.uncoveredKeys.length} Tour cards have no guide page yet, so Aman cannot explain them: ${result.uncoveredKeys.join(', ')}. The build still passes.`,
        );
      }
    })
    .catch(error => {
      console.error(error instanceof AmanGuideBuildError ? error.message : error);
      process.exitCode = 1;
    });
}
