import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { estimateTokens } from '../../../../src/runtime/memory/markdownMemoryFiles';
import {
  DRAFTING_HEADING,
  draftingLines,
  HOUSEHOLD_LINE,
  loadPagesForMessage,
  renderPageForModel,
  writingInstructions,
} from '../../../../src/runtime/memory/memoryPageLoader';
import { parseMemoryPage, type PageFrontMatter } from '../../../../src/runtime/memory/memoryPages';
import { pageText, writePageFile, type FixtureFact } from './pageFixtures';

const WENDY = `---
kind: person
title: Wendy
aliases: [Wendy, my wife, wendy@example.com]
household: true
---
# Wendy

The owner's wife. Lives with them; plans are shared.

## How you write to them
- Short and casual. No sign-off. <!-- fact: id=f_01 src=sent_mail since=2026-10-31 -->

## Now
- Booked the movie for Saturday 7 PM. <!-- fact: id=f_02 src=mail since=2026-10-30 until=2026-11-01 -->
- Hand-written line with no marker yet

## Unconfirmed
- Might be travelling the week of Nov 16. <!-- fact: id=f_03 src=read_content seen=2026-10-29 -->

## Earlier
- Worked at Acme. <!-- fact: id=f_04 src=you_said since=2024-01 until=2026-03 -->
`;

async function makeVault(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'page-loader-'));
}

async function writeFresh(vaultDir: string, slug: string, front: PageFrontMatter, facts = 1): Promise<void> {
  const fixtureFacts: FixtureFact[] = Array.from({ length: facts }, (_unused, index) => ({
    section: 'Now',
    text: `fact ${String(index)} about ${front.title}`,
    marker: { kind: 'fact', id: `f_${slug}${String(index)}`, src: 'you_said' },
  }));
  await writePageFile({ vaultDir, kind: front.kind, slug, content: pageText({ front, facts: fixtureFacts }) });
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

describe('memoryPageLoader', () => {
  it('renders a page for the model with sources and dates in plain words', () => {
    const text = renderPageForModel({
      title: 'Wendy',
      page: parseMemoryPage({ content: WENDY, fallback: { kind: 'person', title: 'Wendy' } }),
    });
    expect(text).toBe(
      [
        '[page: Wendy — person, household; also called: my wife, wendy@example.com]',
        "The owner's wife. Lives with them; plans are shared.",
        'Now:',
        '- Booked the movie for Saturday 7 PM. (from mail, 2026-10-30 to 2026-11-01)',
        '- Hand-written line with no marker yet (you wrote)',
        'Unconfirmed (not confirmed by you):',
        '- Might be travelling the week of Nov 16. (read content, not confirmed, seen 2026-10-29)',
        'Earlier:',
        '- Worked at Acme. (you said, 2024-01 to 2026-03)',
      ].join('\n'),
    );
  });

  it('puts the drafting lines in their own block, with the household line, and not in the page text', () => {
    const page = parseMemoryPage({ content: WENDY, fallback: { kind: 'person', title: 'Wendy' } });
    expect(draftingLines({ title: 'Wendy', page })).toEqual([
      'Wendy:',
      '- Short and casual. No sign-off.',
      `- ${HOUSEHOLD_LINE}`,
    ]);
    expect(DRAFTING_HEADING).toContain('follow when drafting');
    expect(renderPageForModel({ title: 'Wendy', page })).not.toContain('Short and casual');
  });

  it('adds the household line even when a household page has no style lines, and nothing for others', () => {
    const household = parseMemoryPage({
      content: '---\nkind: person\ntitle: Wendy\nhousehold: true\n---\n',
      fallback: { kind: 'person', title: 'Wendy' },
    });
    expect(draftingLines({ title: 'Wendy', page: household })).toEqual(['Wendy:', `- ${HOUSEHOLD_LINE}`]);
    const plain = parseMemoryPage({ content: '## Now\n- x\n', fallback: { kind: 'person', title: 'Sam' } });
    expect(draftingLines({ title: 'Sam', page: plain })).toEqual([]);
  });

  it('lists the writing instructions of a person page', () => {
    const page = parseMemoryPage({ content: WENDY, fallback: { kind: 'person', title: 'Wendy' } });
    expect(writingInstructions(page)).toEqual(['Short and casual. No sign-off.']);
  });

  it('counts a bullet the person typed by hand under "How you write to them" as an instruction', () => {
    const page = parseMemoryPage({
      content: '---\nkind: person\ntitle: Sam\n---\n# Sam\n\n## How you write to them\n- First names only.\n',
      fallback: { kind: 'person', title: 'Sam' },
    });
    expect(writingInstructions(page)).toEqual(['First names only.']);
  });

  it('hands back Wendy’s drafting lines when a message names "my wife"', async () => {
    const vaultDir = await makeVault();
    await mkdir(path.join(vaultDir, 'people'), { recursive: true });
    await writeFile(path.join(vaultDir, 'people', 'wendy.md'), WENDY);
    const { pages } = await loadPagesForMessage({
      vaultDirs: [vaultDir],
      writeVaultDir: vaultDir,
      message: 'Book the movie with my wife',
      maxPages: 6,
      maxTokens: 5000,
    });
    expect(pages.map(page => page.drafting)).toEqual([
      ['Wendy:', '- Short and casual. No sign-off.', `- ${HOUSEHOLD_LINE}`],
    ]);
    expect(pages[0]?.text).not.toContain('Short and casual');
  });

  it('loads the pages a message names, own vault first, people before matters', async () => {
    const own = await makeVault();
    const shared = await makeVault();
    await writeFresh(own, 'wendy', { kind: 'person', title: 'Wendy', aliases: ['my wife'], household: true });
    await writeFresh(shared, 'madrid', { kind: 'matter', title: 'Madrid', aliases: ['the move'], status: 'active' });
    await writeFresh(shared, 'sam', { kind: 'person', title: 'Sam', aliases: [], household: false });
    const { pages, stats } = await loadPagesForMessage({
      vaultDirs: [own, shared],
      writeVaultDir: own,
      message: 'Is the move on? Ask Sam, and my wife.',
      maxPages: 6,
      maxTokens: 5_000,
    });
    expect(pages.map(page => [page.slug, page.vaultDir === own ? 'own' : 'shared', page.reason])).toEqual([
      ['wendy', 'own', 'direct'],
      ['sam', 'shared', 'direct'],
      ['madrid', 'shared', 'direct'],
    ]);
    expect(stats).toEqual({ candidates: 3, loaded: 3, dropped_over_count: 0, dropped_over_budget: 0 });
    expect(pages[0]?.text).toContain('[page: Wendy — person, household');
    // Reading a vault the scope does not write never leaves files in it.
    expect(await exists(path.join(own, '.memory-state', 'aliases.json'))).toBe(true);
    expect(await exists(path.join(shared, '.memory-state', 'aliases.json'))).toBe(false);
  });

  it('ranks a direct mention above a possessive one, whatever their order in the message', async () => {
    const vaultDir = await makeVault();
    await writeFresh(vaultDir, 'wendy', { kind: 'person', title: 'Wendy', aliases: [], household: true });
    await writeFresh(vaultDir, 'sam', { kind: 'person', title: 'Sam', aliases: [], household: false });
    const { pages } = await loadPagesForMessage({
      vaultDirs: [vaultDir],
      writeVaultDir: vaultDir,
      message: "Wendy's sister asked Sam about it",
      maxPages: 6,
      maxTokens: 5_000,
    });
    expect(pages.map(page => [page.slug, page.reason])).toEqual([
      ['sam', 'direct'],
      ['wendy', 'possessive'],
    ]);
  });

  it('names page files whose file name is not a lowercase page name, and still loads the rest', async () => {
    const vaultDir = await makeVault();
    await writeFresh(vaultDir, 'wendy', { kind: 'person', title: 'Wendy', aliases: [], household: false });
    await writePageFile({ vaultDir, kind: 'person', slug: 'Wendy', content: '# Wendy\n' });
    await writePageFile({ vaultDir, kind: 'matter', slug: 'my notes', content: '# Notes\n' });
    const { pages, skippedFiles } = await loadPagesForMessage({
      vaultDirs: [vaultDir],
      writeVaultDir: vaultDir,
      message: 'Wendy?',
      maxPages: 6,
      maxTokens: 5_000,
    });
    expect(pages.map(page => page.slug)).toEqual(['wendy']);
    expect(skippedFiles.sort()).toEqual(['matters/my notes.md', 'people/Wendy.md']);
  });

  it('skips a slug already loaded from an earlier vault', async () => {
    const own = await makeVault();
    const shared = await makeVault();
    await writeFresh(own, 'wendy', { kind: 'person', title: 'Wendy', aliases: ['own copy'], household: true });
    await writeFresh(shared, 'wendy', { kind: 'person', title: 'Wendy', aliases: ['shared copy'], household: false });
    const { pages, stats } = await loadPagesForMessage({
      vaultDirs: [own, shared],
      writeVaultDir: own,
      message: 'Wendy?',
      maxPages: 6,
      maxTokens: 5_000,
    });
    expect(pages).toHaveLength(1);
    expect(pages[0]?.vaultDir).toBe(own);
    expect(stats.candidates).toBe(1);
  });

  it('holds the page count cap in priority order', async () => {
    const vaultDir = await makeVault();
    const names = ['Ann', 'Ben', 'Cal', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal'];
    for (const name of names) {
      await writeFresh(vaultDir, name.toLowerCase(), { kind: 'person', title: name, aliases: [], household: false });
    }
    const { pages, stats } = await loadPagesForMessage({
      vaultDirs: [vaultDir],
      writeVaultDir: vaultDir,
      message: names.join(', '),
      maxPages: 6,
      maxTokens: 50_000,
    });
    expect(pages.map(page => page.title)).toEqual(['Ann', 'Ben', 'Cal', 'Dee', 'Eve', 'Fay']);
    expect(stats).toEqual({ candidates: 8, loaded: 6, dropped_over_count: 2, dropped_over_budget: 0 });
  });

  it('holds the token cap and drops every page after the first that does not fit', async () => {
    const vaultDir = await makeVault();
    await writeFresh(vaultDir, 'ann', { kind: 'person', title: 'Ann', aliases: [], household: false }, 2);
    await writeFresh(vaultDir, 'ben', { kind: 'person', title: 'Ben', aliases: [], household: false }, 40);
    await writeFresh(vaultDir, 'cal', { kind: 'person', title: 'Cal', aliases: [], household: false }, 1);
    const probe = await loadPagesForMessage({
      vaultDirs: [vaultDir],
      writeVaultDir: vaultDir,
      message: 'Ann',
      maxPages: 6,
      maxTokens: 50_000,
    });
    const annTokens = probe.pages[0]?.estimatedTokens ?? 0;
    expect(annTokens).toBe(estimateTokens(probe.pages[0]?.text ?? ''));
    const { pages, stats } = await loadPagesForMessage({
      vaultDirs: [vaultDir],
      writeVaultDir: vaultDir,
      message: 'Ann, Ben and Cal',
      maxPages: 6,
      maxTokens: annTokens + 20,
    });
    expect(pages.map(page => page.title)).toEqual(['Ann']);
    expect(stats).toEqual({ candidates: 3, loaded: 1, dropped_over_count: 0, dropped_over_budget: 2 });
    expect(pages.reduce((sum, page) => sum + page.estimatedTokens, 0)).toBeLessThanOrEqual(annTokens + 20);
  });

  it('loads nothing from a vault with no pages, or an unreadable one, and never throws', async () => {
    const vaultDir = await makeVault();
    const result = await loadPagesForMessage({
      vaultDirs: [vaultDir, path.join(vaultDir, 'missing')],
      writeVaultDir: vaultDir,
      message: 'Wendy',
      maxPages: 6,
      maxTokens: 1_000,
    });
    expect(result.pages).toEqual([]);
    expect(result.stats).toEqual({ candidates: 0, loaded: 0, dropped_over_count: 0, dropped_over_budget: 0 });
  });
});
