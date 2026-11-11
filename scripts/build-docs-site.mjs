#!/usr/bin/env node
// Lays out the docs website's source pages from docs/ and the in-app help topics, so the pages
// people read on GitHub stay the only copy. MkDocs then builds the site from the folder this writes.
// Run by `pnpm docs:site:build`, before MkDocs builds the site.

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const REPO_BLOB_BASE = 'https://github.com/ClimbOutLabs/amanuensis/blob/main';

/** Where the help topics land on the site, next to the docs pages. */
export const HELP_DIR = 'help';

const TOPICS_FROM_DOCS = '../packages/trueforge/guide/topics/';

/** Files under docs/ that are for maintainers or tooling, not readers of the site. */
const SKIPPED = new Set(['docs.json', 'TEST_RATIONALIZATION_REPORT.md']);

const CALLOUTS = { Note: 'note', Info: 'info', Tip: 'tip', Warning: 'warning', Check: 'success' };
const DROPPED = new Set(['AccordionGroup', 'CardGroup', 'Steps', 'Tabs', 'CodeGroup', 'Frame', 'Columns']);

function attribute(tag, name) {
  const match = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|\\{["']([^"']*)["']\\})`).exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function hasFlag(tag, name) {
  return new RegExp(`\\s${name}(?=[\\s/>])`).test(tag);
}

/** The line that opens a container, or undefined when the tag is dropped and its content kept as is. */
function openLine(name, tag) {
  const title = attribute(tag, 'title');
  if (name in CALLOUTS) {
    return title ? `!!! ${CALLOUTS[name]} "${title}"` : `!!! ${CALLOUTS[name]}`;
  }
  if (name === 'Accordion' || name === 'Expandable') {
    return `??? note "${title ?? 'More'}"`;
  }
  if (name === 'Tab') {
    return `=== "${title ?? 'Tab'}"`;
  }
  return undefined;
}

/** Text that replaces a tag which becomes a plain line instead of a container. */
function headLine(name, tag) {
  const title = attribute(tag, 'title');
  if (name === 'Step') {
    return title ? `**${title}**` : '';
  }
  if (name === 'Card') {
    const href = attribute(tag, 'href');
    const label = title ?? href ?? '';
    return href ? `**[${label}](${href})**` : `**${label}**`;
  }
  if (name === 'ParamField' || name === 'ResponseField') {
    const field = attribute(tag, 'path') ?? attribute(tag, 'query') ?? attribute(tag, 'body') ?? attribute(tag, 'name');
    const parts = [attribute(tag, 'type') ? `\`${attribute(tag, 'type')}\`` : undefined];
    if (hasFlag(tag, 'required')) {
      parts.push('required');
    }
    const kind = parts.filter(Boolean).join(', ');
    return `**\`${field ?? ''}\`**${kind ? ` (${kind})` : ''}`;
  }
  return undefined;
}

const OPEN_TAG = /^(\s*)<([A-Z][A-Za-z]*)\b([^>]*?)(\/?)>\s*(.*)$/;
const CLOSE_TAG = /^(\s*)<\/([A-Z][A-Za-z]*)>\s*$/;

/**
 * Turns the Mintlify tags in an .mdx page into Markdown that MkDocs Material shows: callouts and
 * accordions become admonitions, tabs become content tabs, steps, cards and fields become bold
 * lines. Code blocks are left alone.
 */
export function convertMintlify(source) {
  const out = [];
  const stack = [];
  let fence;
  const depth = () => stack.filter(entry => entry.indents).length;
  const push = line => {
    if (line.trim() === '') {
      out.push('');
      return;
    }
    const top = stack.at(-1);
    let text = line;
    if (top && top.contentIndent === undefined) {
      top.contentIndent = line.length - line.trimStart().length;
    }
    const strip = top?.contentIndent ?? 0;
    const lead = text.length - text.trimStart().length;
    text = text.slice(Math.min(strip, lead));
    out.push(' '.repeat(4 * depth()) + text);
  };

  for (const raw of source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').split('\n')) {
    const fenceMatch = /^\s*(```+|~~~+)(.*)$/.exec(raw);
    if (fence) {
      push(raw);
      if (fenceMatch && fenceMatch[1].startsWith(fence) && fenceMatch[2].trim() === '') {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      // Mintlify writes a code block's title after its language; MkDocs wants it as title="…".
      const info = /^(\S+)\s+(.+)$/.exec(fenceMatch[2].trim());
      const line = info && !info[2].includes('=') ? raw.replace(fenceMatch[2], `${info[1]} title="${info[2]}"`) : raw;
      push(line);
      continue;
    }

    const close = CLOSE_TAG.exec(raw);
    if (close && stack.length > 0 && stack.at(-1).name === close[2]) {
      stack.pop();
      out.push('');
      continue;
    }

    const open = OPEN_TAG.exec(raw);
    if (
      open &&
      (DROPPED.has(open[2]) || openLine(open[2], open[3]) || headLine(open[2], `<x ${open[3]}>`) !== undefined)
    ) {
      const [, , name, attrs, selfClosing, rest] = open;
      const tag = `<${name} ${attrs}>`;
      const container = openLine(name, tag);
      const head = headLine(name, tag);
      const inlineClose = new RegExp(`</${name}>\\s*$`);
      const restText = rest.replace(inlineClose, '').trim();
      const closesHere = selfClosing === '/' || inlineClose.test(rest);
      if (container) {
        push('');
        push(container);
        if (closesHere) {
          out.push(' '.repeat(4 * (depth() + 1)) + restText, '');
        } else {
          stack.push({ name, indents: true, contentIndent: undefined });
          if (restText) {
            push(restText);
          }
        }
      } else {
        if (head) {
          push('');
          push(head);
          push('');
        }
        if (restText) {
          push(restText);
        }
        if (!closesHere) {
          stack.push({ name, indents: false, contentIndent: undefined });
        }
      }
      continue;
    }

    push(raw.replace(/<Tooltip\b[^>]*>(.*?)<\/Tooltip>/g, '$1'));
  }
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .trimEnd()}\n`;
}

/**
 * Points a docs page's links at the site's copies: .mdx pages become .md, the help topics move
 * under help/, and anything else outside docs/ links to the file on GitHub.
 */
export function rewriteLinks(markdown, { fromHelp, fromFile = 'index.md', pages = new Set() }) {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    if (/^[a-z]+:/i.test(target) || target.startsWith('#')) {
      return whole;
    }
    // Mintlify links pages from the site root without an extension, such as /api/quickstart.
    const rooted = /^\/([^#]*)(#.*)?$/.exec(target);
    if (rooted) {
      const page = [`${rooted[1]}.md`, `${rooted[1]}/index.md`].find(name => pages.has(name));
      if (!page) {
        return whole;
      }
      const relative = path.posix.relative(path.posix.dirname(fromFile), page);
      return `](${relative}${rooted[2] ?? ''})`;
    }
    let link = target.replace(/\.mdx(?=$|#)/, '.md');
    if (!fromHelp && link.startsWith(TOPICS_FROM_DOCS)) {
      link = `${HELP_DIR}/${link.slice(TOPICS_FROM_DOCS.length)}`;
    } else if (!fromHelp && link.startsWith('../')) {
      link = `${REPO_BLOB_BASE}/${link.slice(3)}`;
    }
    return `](${link})`;
  });
}

/** The topic front matter is for the in-app help; the site only needs the title. */
export function siteFrontMatter(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (!match) {
    return markdown;
  }
  const keep = match[1].split('\n').filter(line => /^(title|description):/.test(line));
  return `---\n${keep.join('\n')}\n---\n${markdown.slice(match[0].length)}`;
}

/** Parts of the docs home for people working on Aman's code. GitHub shows them; the website does not. */
export const SITE_LEAVES_OUT = ['Developer guide', 'Reference', 'Project'];

/**
 * The docs home as the website shows it: without the sections in SITE_LEAVES_OUT, and without their
 * rows in the table of guides. Their pages are still built, so links to them work.
 */
export function siteDocsHome(markdown) {
  const out = [];
  let skipping = false;
  for (const line of markdown.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      skipping = SITE_LEAVES_OUT.includes(heading[1].trim());
    }
    const guideRow = /^(?:\|\s*|-\s+)\[([^\]]+)\]\(#[^)]*\)/.exec(line);
    if (skipping || (guideRow && SITE_LEAVES_OUT.includes(guideRow[1]))) {
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Builds the site menu from the docs home: each "## Guide" is a section, each bold line inside
 * it a subsection, and the first link in each list item (or table row) a page. Links to a heading or another
 * site stay on the home page only.
 */
export function navFromDocsHome(markdown) {
  const nav = [{ Home: 'index.md' }];
  let section;
  let group;
  for (const line of markdown.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      section = { [heading[1].trim()]: [] };
      nav.push(section);
      group = undefined;
      continue;
    }
    if (!section) {
      continue;
    }
    const items = Object.values(section)[0];
    const bold = /^\*\*(.+)\*\*$/.exec(line.trim());
    if (bold) {
      group = { [bold[1]]: [] };
      items.push(group);
      continue;
    }
    const row = /^(?:\|\s*|-\s+)\[([^\]]+)\]\(([^)\s#]+)\)/.exec(line);
    if (!row || /^[a-z]+:/i.test(row[2])) {
      continue;
    }
    const page = rewriteLinks(`](${row[2]})`, { fromHelp: false }).slice(2, -1);
    if (/^[a-z]+:/i.test(page) || !/\.md$/.test(page)) {
      continue;
    }
    (group ? Object.values(group)[0] : items).push({ [row[1]]: page });
  }
  return nav;
}

async function walk(dir, base = dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full, base)));
    } else {
      files.push(path.relative(base, full));
    }
  }
  return files;
}

export async function buildDocsSite({
  docsDir = path.join(repoRoot, 'docs'),
  topicsDir = path.join(repoRoot, 'packages/trueforge/guide/topics'),
  outDir = path.join(repoRoot, 'docs-site/pages'),
  configPath = path.join(repoRoot, 'docs-site/build.yml'),
} = {}) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const docsFiles = (await walk(docsDir)).filter(file => !SKIPPED.has(file));
  const pages = new Set(
    docsFiles
      .filter(file => /\.mdx?$/.test(file))
      .map(file => (file === 'README.md' ? 'index.md' : file.replace(/\.mdx$/, '.md'))),
  );
  for (const file of docsFiles) {
    const from = path.join(docsDir, file);
    if (!/\.mdx?$/.test(file)) {
      await mkdir(path.dirname(path.join(outDir, file)), { recursive: true });
      await cp(from, path.join(outDir, file));
      continue;
    }
    let text = await readFile(from, 'utf8');
    if (file.endsWith('.mdx')) {
      text = convertMintlify(text);
    }
    const target = file === 'README.md' ? 'index.md' : file.replace(/\.mdx$/, '.md');
    if (file === 'README.md') {
      text = siteDocsHome(text);
    }
    await mkdir(path.dirname(path.join(outDir, target)), { recursive: true });
    await writeFile(path.join(outDir, target), rewriteLinks(text, { fromHelp: false, fromFile: target, pages }));
  }

  // Aman's own font, mark and site style, copied from the app so the site matches it.
  const brandDir = path.join(outDir, 'assets', 'aman');
  await mkdir(brandDir, { recursive: true });
  await cp(path.join(repoRoot, 'packages/trueforge-ui/src/fonts.css'), path.join(brandDir, 'fonts.css'));
  await cp(path.join(repoRoot, 'packages/frontend/public/favicon.svg'), path.join(brandDir, 'logo.svg'));
  await cp(path.join(repoRoot, 'docs-site/aman.css'), path.join(brandDir, 'aman.css'));

  await mkdir(path.join(outDir, HELP_DIR), { recursive: true });
  for (const name of (await readdir(topicsDir)).filter(n => n.endsWith('.md'))) {
    const text = await readFile(path.join(topicsDir, name), 'utf8');
    await writeFile(path.join(outDir, HELP_DIR, name), rewriteLinks(siteFrontMatter(text), { fromHelp: true }));
  }
  // The settings live in docs-site/mkdocs.yml; this file adds the menu built from the docs home.
  const nav = navFromDocsHome(siteDocsHome(await readFile(path.join(docsDir, 'README.md'), 'utf8')));
  const config = {
    INHERIT: path.relative(path.dirname(configPath), path.join(repoRoot, 'docs-site/mkdocs.yml')),
    docs_dir: path.relative(path.dirname(configPath), outDir),
    nav,
  };
  await writeFile(
    configPath,
    `# Written by scripts/build-docs-site.mjs. Do not edit by hand.\n${JSON.stringify(config, null, 2)}\n`,
  );
  return outDir;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const outDir = await buildDocsSite();
  console.log(`Docs site pages written to ${path.relative(repoRoot, outDir)}.`);
}
