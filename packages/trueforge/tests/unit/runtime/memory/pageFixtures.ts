import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';

import type { FactMarker } from '../../../../src/runtime/memory/memoryNotes';
import { formatMarker } from '../../../../src/runtime/memory/memoryNotes';
import {
  pagePath,
  parseMemoryPage,
  type MemoryPage,
  type PageFrontMatter,
  type PageKind,
  type PageSection,
  type PageSectionBlock,
} from '../../../../src/runtime/memory/memoryPages';

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
      lines.push(`- ${fact.text} ${formatMarker(fact.marker)}`);
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
