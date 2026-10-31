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

// The exported table that holds every Tour card, keyed by card id. The pills only name these keys.
const TOUR_CARDS_EXPORT = 'CARDS';

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
    docsDir: path.join(repoRoot, 'docs'),
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

/** The expression inside `satisfies`, `as const` and parentheses, which only add type information. */
function withoutTypeWrappers(node) {
  let current = node;
  while (
    current !== undefined &&
    (ts.isSatisfiesExpression(current) || ts.isAsExpression(current) || ts.isParenthesizedExpression(current))
  ) {
    current = current.expression;
  }
  return current;
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

/** Reads the Tour cards from the card table in tourPrompts.ts source, without running the UI. */
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

  if (!exported.has(TOUR_CARDS_EXPORT)) {
    throw new AmanGuideBuildError(
      `tourPrompts.ts must export ${TOUR_CARDS_EXPORT}, the table the guide build reads the Tour cards from. Add export to its declaration.`,
    );
  }
  const table = withoutTypeWrappers(declarations.get(TOUR_CARDS_EXPORT));
  if (!ts.isObjectLiteralExpression(table)) {
    throw new AmanGuideBuildError(
      `${TOUR_CARDS_EXPORT} in tourPrompts.ts must be a table of cards keyed by card id. Write it as { key: { title: ... }, ... }.`,
    );
  }
  const cards = new Map();
  for (const property of table.properties) {
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
      throw new AmanGuideBuildError(
        `Every entry in ${TOUR_CARDS_EXPORT} must be a card id and a card. Write each one as key: { title: ... }, not a spread or a computed key.`,
      );
    }
    const key = property.name.text;
    const card = withoutTypeWrappers(property.initializer);
    if (!ts.isObjectLiteralExpression(card)) {
      throw new AmanGuideBuildError(
        `Tour card "${key}" must be written out in ${TOUR_CARDS_EXPORT}. Write the card as an object with a title in place of the name it points to.`,
      );
    }
    const props = propertyMap(card);
    const label = literalText(props.get('title'), `Tour card "${key}" title`);
    const needs = props.has('needs') ? capabilityList(props.get('needs'), `Tour card "${key}" needs`) : [];
    for (const name of needs) {
      if (!capabilityKeys.has(name)) {
        throw new AmanGuideBuildError(`Tour card "${key}" needs "${name}", which TourCapabilities does not declare.`);
      }
    }
    cards.set(key, { label, needs });
  }
  if (cards.size === 0) {
    throw new AmanGuideBuildError(
      `No Tour cards found in ${TOUR_CARDS_EXPORT} in tourPrompts.ts. Add at least one card with a title.`,
    );
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

/** The public repository path a docs page is read from, named in every chunk so the guide can link to it. */
const DOCS_PUBLIC_BASE = 'https://github.com/ClimbOutLabs/amanuensis/blob/main/docs';

/** Longest body one knowledge entry may carry; longer sections are packed at paragraph breaks. */
const DOCS_CHUNK_MAX = 6000;

/** Front matter fields of a docs page, with the quotes Mintlify writes around values removed. */
function parseFrontMatter(text, fileName) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (match === null) {
    throw new AmanGuideBuildError(`${fileName} must start with a front matter block between --- lines.`);
  }
  const fields = new Map();
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      const value = line.slice(separator + 1).trim();
      const unquoted =
        (value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))
          ? value.slice(1, -1)
          : value;
      fields.set(line.slice(0, separator).trim(), unquoted);
    }
  }
  return { fields, body: match[2] };
}

/**
 * A docs page stays out of the pack when it is generated reference material: an
 * `openapi` field in its front matter, or a reference step in its path.
 */
function isApiReferencePage({ fields, fileName }) {
  if (fields.has('openapi')) {
    return true;
  }
  return fileName.split('/').some(segment => segment === 'reference' || segment === 'api-reference');
}

/** Drops the lines only MDX can read: imports, exports and lines that are nothing but a component tag. */
function proseLines(body) {
  const kept = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (inFence) {
      kept.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (/^(import|export)\s/.test(trimmed)) {
      continue;
    }
    if (/^<\/?[A-Za-z][^>]*>$/.test(trimmed)) {
      continue;
    }
    kept.push(line);
  }
  return kept;
}

/** Splits a page body at its ## headings, then packs paragraphs so no chunk passes the size cap. */
function chunkDocsBody(body) {
  const sections = [];
  let heading = null;
  let lines = [];
  let inFence = false;
  const flush = () => {
    const text = lines.join('\n').trim();
    if (text !== '') {
      sections.push({ heading, text });
    }
    lines = [];
  };
  for (const line of proseLines(body)) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
    }
    if (!inFence && line.startsWith('## ')) {
      flush();
      heading = line.slice(3).trim();
      continue;
    }
    lines.push(line);
  }
  flush();
  const chunks = [];
  for (const section of sections) {
    if (section.text.length <= DOCS_CHUNK_MAX) {
      chunks.push(section);
      continue;
    }
    let packed = '';
    for (const paragraph of section.text.split('\n\n')) {
      const candidate = packed === '' ? paragraph : `${packed}\n\n${paragraph}`;
      if (candidate.length > DOCS_CHUNK_MAX && packed !== '') {
        chunks.push({ heading: section.heading, text: packed });
        packed = paragraph;
      } else {
        packed = candidate;
      }
    }
    if (packed !== '') {
      chunks.push({ heading: section.heading, text: packed });
    }
  }
  return chunks;
}

/**
 * Reads the public docs pages into knowledge entries. Each entry names the page
 * it came from, so an answer built on it can carry the link. Docs entries cover
 * no Tour cards; the coverage check stays about the hand-written pages.
 */
async function readDocs(docsDir) {
  let names;
  try {
    names = (await readdir(docsDir)).filter(name => name.endsWith('.mdx')).sort();
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const entries = [];
  for (const name of names) {
    const { fields, body } = parseFrontMatter(await readFile(path.join(docsDir, name), 'utf8'), name);
    if (isApiReferencePage({ fields, fileName: name })) {
      continue;
    }
    const title = fields.get('title') ?? fields.get('sidebarTitle') ?? '';
    if (title === '') {
      throw new AmanGuideBuildError(`Docs page "${name}" needs a title in its front matter.`);
    }
    const slug =
      name
        .replace(/\.mdx$/, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-') || 'page';
    const sourceLine = `Public source: ${DOCS_PUBLIC_BASE}/${name}`;
    const chunks = chunkDocsBody(body);
    chunks.forEach((chunk, index) => {
      entries.push({
        id: index === 0 ? `docs-${slug}` : `docs-${slug}-${index + 1}`,
        title: chunk.heading === null || (index === 0 && chunks.length === 1) ? title : `${title}: ${chunk.heading}`,
        covers: [],
        body: `${chunk.text}\n\n${sourceLine}`,
      });
    });
  }
  return entries;
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
    '// Generated by scripts/build-aman-guide.mjs from packages/trueforge/guide/topics, the public docs pages and the Tour cards. Do not edit by hand.',
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
  const pages = await readTopics(paths.topicsDir);
  const docsEntries = await readDocs(paths.docsDir);
  const topics = [...pages, ...docsEntries];
  const requiredKeys = await readRequiredCards(paths.requiredCardsPath);
  const uncoveredKeys = checkTopics({ topics, cards: tour.cards, requiredKeys });
  const output = await render({ topics, repoRoot, outPath: paths.outPath });
  await mkdir(path.dirname(paths.outPath), { recursive: true });
  await writeFile(paths.outPath, output);
  return {
    outPath: paths.outPath,
    topics: topics.map(({ id, title, covers }) => ({ id, title, covers })),
    tourKeys: [...tour.cards.keys()],
    uncoveredKeys,
  };
}

function pickDefined(options) {
  return Object.fromEntries(
    ['tourPath', 'topicsDir', 'docsDir', 'requiredCardsPath', 'outPath']
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
