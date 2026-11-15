import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';

import type { FactMarker } from '../../../../src/runtime/memory/memoryNotes';
import { draftingLines, HOUSEHOLD_LINE } from '../../../../src/runtime/memory/memoryPageLoader';
import {
  pagePath,
  parseMemoryPage,
  type MemoryPage,
  type PageFrontMatter,
  type PageKind,
  type PageSection,
  type PageSectionBlock,
} from '../../../../src/runtime/memory/memoryPages';

/** A person page as a person would keep it. */
export const NORA = `---
kind: person
title: Nora
aliases: [Nora, my wife, nora@example.com]
household: true
---
# Nora

The owner's wife. Lives with them; plans are shared.

## How you write to them
- Short and casual. No sign-off. <!-- fact: id=f_01 src=sent_mail since=2026-10-31 -->

## Now
- Booked the movie for Saturday 7 PM. <!-- fact: id=f_02 src=mail since=2026-10-30 until=2026-11-01 -->

## Unconfirmed
- Might be travelling the week of Nov 16. <!-- fact: id=f_03 src=read_content seen=2026-10-29 -->

## Earlier
- Worked at Acme. <!-- fact: id=f_04 src=you_said since=2024-01 until=2026-03 -->
`;

/** A matter page with a key the format does not know. */
export const MADRID = `---
kind: matter
title: The Madrid move
aliases: [Madrid, the move]
status: active
colour: teal
---
# The Madrid move

Moving the family to Madrid in spring.

## Now
- Lease on Calle Mayor signed through 2027. <!-- fact: id=f_10 src=you_said since=2026-10-20 -->

## Decided
- Shipping the furniture, not selling it. <!-- fact: id=f_11 src=you_said since=2026-10-22 -->

## Open
- Which school for Leo. <!-- fact: id=f_12 src=you_said since=2026-10-22 -->

## Unconfirmed

## Earlier
`;
export interface FixtureFact {
  section: PageSection;
  text: string;
  marker: FactMarker;
}

/** The section names a page may have; a test checks the parser still reads each as a known section. */
export const SECTION_NAMES: readonly PageSection[] = [
  'How you write to them',
  'Now',
  'Decided',
  'Open',
  'Unconfirmed',
  'Earlier',
];

const FLOW = { lineWidth: 0, collectionStyle: 'flow', flowCollectionPadding: false } as const;
const LINE = { lineWidth: 0 } as const;

const DEFAULT_SECTIONS: Readonly<Record<PageKind, readonly PageSection[]>> = {
  person: ['How you write to them', 'Now', 'Unconfirmed', 'Earlier'],
  matter: ['Now', 'Decided', 'Open', 'Unconfirmed', 'Earlier'],
};

/** A page file's text: front matter, title, optional summary, then each section with its facts. */
export function pageText({
  front,
  facts = [],
  summary,
}: {
  front: PageFrontMatter;
  facts?: FixtureFact[];
  summary?: string | undefined;
}): string {
  const kindLine = front.kind === 'person' ? `household: ${String(front.household)}` : `status: ${front.status}`;
  const lines = [
    '---',
    `kind: ${front.kind}`,
    `title: ${stringify(front.title, LINE).trimEnd()}`,
    `aliases: ${stringify(front.aliases, FLOW).trimEnd()}`,
    kindLine,
    '---',
    `# ${front.title}`,
    '',
    summary ?? '',
    '',
  ];
  for (const name of SECTION_NAMES) {
    const own = facts.filter(fact => fact.section === name);
    if (own.length === 0 && !DEFAULT_SECTIONS[front.kind].includes(name)) {
      continue;
    }
    lines.push(`## ${name}`);
    for (const fact of own) {
      lines.push(`- ${fact.text} ${formatFactMarker(fact.marker)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function pageOf(input: Parameters<typeof pageText>[0]): MemoryPage {
  return parseMemoryPage({ content: pageText(input), fallback: { kind: input.front.kind, title: input.front.title } });
}

export async function writePageFile({
  vaultDir,
  kind,
  slug,
  content,
}: {
  vaultDir: string;
  kind: PageKind;
  slug: string;
  content: string;
}): Promise<void> {
  const file = pagePath({ vaultDir, kind, slug });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** Every readable fact on the page with the section it sits in, in page order. */
export function factsOf(page: MemoryPage): { section: PageSectionBlock; fact: { text: string; marker: FactMarker } }[] {
  return page.sections.flatMap(section =>
    section.lines.flatMap(line => (line.kind === 'fact' ? [{ section, fact: line.fact }] : [])),
  );
}

/** A fact marker as a hand-written page carries it, keys in the order the format lists them. */
export function formatFactMarker(marker: FactMarker): string {
  const keys = ['id', 'src', 'since', 'until', 'seen'] as const;
  const parts = keys.flatMap(key => (marker[key] === undefined ? [] : [`${key}=${marker[key]}`]));
  return `<!-- fact: ${parts.join(' ')} -->`;
}

/** The "How you write to them" instructions a person page hands to drafting, without the household line. */
export function writingInstructionsOf(page: MemoryPage): string[] {
  return draftingLines({ title: 'x', page })
    .slice(1)
    .map(line => line.replace(/^- /, ''))
    .filter(line => line !== HOUSEHOLD_LINE);
}
