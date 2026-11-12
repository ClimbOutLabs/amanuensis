import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildDocsSite,
  convertMintlify,
  navFromDocsHome,
  REPO_BLOB_BASE,
  rewriteLinks,
  siteDocsHome,
  siteFrontMatter,
} from '../scripts/build-docs-site.mjs';

test('a callout becomes an admonition with its content indented', () => {
  const out = convertMintlify('Before\n\n<Note>\n  First line.\n  Second line.\n</Note>\n\nAfter\n');
  assert.equal(out, 'Before\n\n!!! note\n    First line.\n    Second line.\n\nAfter\n');
});

test('a one-line warning keeps its text', () => {
  assert.match(convertMintlify('<Warning>Back up first.</Warning>\n'), /!!! warning\n {4}Back up first\./);
});

test('accordions become collapsed blocks and their group tag goes away', () => {
  const out = convertMintlify(
    '<AccordionGroup>\n<Accordion title="Why?">\nBecause.\n</Accordion>\n</AccordionGroup>\n',
  );
  assert.equal(out, '??? note "Why?"\n    Because.\n');
});

test('tabs become content tabs', () => {
  const out = convertMintlify(
    '<Tabs>\n  <Tab title="Mac">\n    Use Terminal.\n  </Tab>\n  <Tab title="Linux">\n    Use a shell.\n  </Tab>\n</Tabs>\n',
  );
  assert.equal(out, '=== "Mac"\n    Use Terminal.\n\n=== "Linux"\n    Use a shell.\n');
});

test('a step becomes a bold line with its content left in place', () => {
  const out = convertMintlify('<Steps>\n  <Step title="Clone">\n    Run git clone.\n  </Step>\n</Steps>\n');
  assert.equal(out, '**Clone**\n\nRun git clone.\n');
});

test('a field becomes a bold line naming its type', () => {
  const out = convertMintlify('<ParamField path="name" type="string" required>\n  The name.\n</ParamField>\n');
  assert.equal(out, '**`name`** (`string`, required)\n\nThe name.\n');
});

test('tags inside a code block are left alone, and a code block title moves to title=', () => {
  const out = convertMintlify('```tsx App.tsx\n<Note>not a callout</Note>\n```\n');
  assert.equal(out, '```tsx title="App.tsx"\n<Note>not a callout</Note>\n```\n');
});

test('links to .mdx pages, help topics and files outside docs are rewritten', () => {
  const out = rewriteLinks(
    '[a](install.mdx#doctor) [b](../packages/trueforge/guide/topics/memory.md) [c](../SECURITY.md) [d](https://x.dev/y.mdx) [e](#top)',
    { fromHelp: false },
  );
  assert.equal(
    out,
    `[a](install.md#doctor) [b](help/memory.md) [c](${REPO_BLOB_BASE}/SECURITY.md) [d](https://x.dev/y.mdx) [e](#top)`,
  );
});

test('a link from the site root points at the page relative to the linking page', () => {
  const pages = new Set(['api/quickstart.md', 'key-features/subagents.md']);
  const out = rewriteLinks('[q](/api/quickstart) [s](/key-features/subagents#why) [x](/nowhere)', {
    fromHelp: false,
    fromFile: 'api/use-agent.md',
    pages,
  });
  assert.equal(out, '[q](quickstart.md) [s](../key-features/subagents.md#why) [x](/nowhere)');
});

test('topic front matter keeps only the title', () => {
  assert.equal(siteFrontMatter('---\nid: x\ntitle: X\ncovers: a\n---\nBody\n'), '---\ntitle: X\n---\nBody\n');
});

test('the menu follows the docs home sections, subsections and first links', () => {
  const home = [
    '# Docs',
    '| [Getting started](#getting-started) | x |',
    '## Getting started',
    '| Page | What |',
    '| [Try Aman](try-aman.md) | x |',
    '| [Doctor](install.mdx#doctor) | skipped: a heading |',
    '## User guide',
    '**Everyday tasks**',
    '- [Email](../packages/trueforge/guide/topics/email.md): x',
    '- [Issues](https://github.com/x): skipped, another site',
    '| [Security](../SECURITY.md) | skipped: on GitHub |',
  ].join('\n');
  assert.deepEqual(navFromDocsHome(home), [
    { Home: 'index.md' },
    { 'Getting started': [{ 'Try Aman': 'try-aman.md' }] },
    { 'User guide': [{ 'Everyday tasks': [{ Email: 'help/email.md' }] }] },
  ]);
});

test('the build lays out pages, topics and the menu', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'docs-site-'));
  const docsDir = path.join(root, 'docs');
  const topicsDir = path.join(root, 'topics');
  await mkdir(path.join(docsDir, 'api'), { recursive: true });
  await mkdir(topicsDir);
  await writeFile(path.join(docsDir, 'README.md'), '# Docs\n## Start\n| [Install](install.mdx) | x |\n');
  await writeFile(
    path.join(docsDir, 'install.mdx'),
    '---\ntitle: Install\n---\n<Tip>Read [the API](/api/quickstart).</Tip>\n',
  );
  await writeFile(path.join(docsDir, 'api', 'quickstart.mdx'), '---\ntitle: Q\n---\nHi\n');
  await writeFile(path.join(docsDir, 'docs.json'), '{}');
  await writeFile(path.join(topicsDir, 'memory.md'), '---\nid: memory\ntitle: Memory\n---\nText\n');
  const outDir = path.join(root, 'site', 'pages');
  const configPath = path.join(root, 'site', 'build.yml');
  await mkdir(path.dirname(outDir), { recursive: true });

  await buildDocsSite({ docsDir, topicsDir, outDir, configPath });

  assert.match(await readFile(path.join(outDir, 'index.md'), 'utf8'), /# Docs/);
  assert.match(
    await readFile(path.join(outDir, 'install.md'), 'utf8'),
    /!!! tip\n {4}Read \[the API\]\(api\/quickstart\.md\)\./,
  );
  assert.equal(await readFile(path.join(outDir, 'help', 'memory.md'), 'utf8'), '---\ntitle: Memory\n---\nText\n');
  await assert.rejects(readFile(path.join(outDir, 'docs.json'), 'utf8'));
  const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^#.*\n/, ''));
  assert.equal(config.docs_dir, 'pages');
  assert.deepEqual(config.nav, [{ Home: 'index.md' }, { Start: [{ Install: 'install.md' }] }]);
});

test('the website leaves out the parts for people working on the code', () => {
  const home = [
    '- [Getting started](#getting-started): x',
    '- [Developer guide](#developer-guide): x',
    '- [Project](#project): x',
    '## Getting started',
    '- [Try Aman](try-aman.md): x',
    '## Developer guide',
    '**Run from source**',
    '- [Quickstart](quickstart.mdx): x',
    '## Reference',
    '- [SDK](api/quickstart.mdx): x',
    '## Project',
    '- [Changelog](CHANGELOG.md): x',
  ].join('\n');
  assert.equal(
    siteDocsHome(home),
    ['- [Getting started](#getting-started): x', '## Getting started', '- [Try Aman](try-aman.md): x'].join('\n'),
  );
});
