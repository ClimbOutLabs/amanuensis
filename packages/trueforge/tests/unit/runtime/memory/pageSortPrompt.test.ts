import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildSortPrompt } from '../../../../src/runtime/memory/pageSortPrompt';
import { writePageFile } from './pageFixtures';

/** A person page holding one line Aman worked out from the person's conversations. */
const PAGE_WITH_AN_INFERRED_LINE = `---
kind: person
title: Nora
aliases: [Nora]
---
# Nora

## Now
- Works at Brightline. <!-- fact: id=f_01 src=you_said since=2026-10-01 -->

## Unconfirmed
- Probably vegetarian. <!-- fact: id=f_02 src=inferred seen=2026-10-29 -->
`;

async function promptWithAnInferredLine() {
  const vaultDir = await mkdtemp(path.join(tmpdir(), 'sort-prompt-'));
  await writePageFile({ vaultDir, kind: 'person', slug: 'nora', content: PAGE_WITH_AN_INFERRED_LINE });
  return buildSortPrompt({
    vaultDir,
    note: { text: 'Nora is coming to dinner on Friday.', day: '2026-11-06' },
    origin: { kind: 'own_words' },
  });
}

describe('the sort prompt', () => {
  it('names an inferred line as worked out from the person’s conversations, never as a guess', async () => {
    const prompt = await promptWithAnInferredLine();
    const whole = prompt.messages.map(message => message.content).join('\n');
    expect(whole).not.toMatch(/guess/i);
    expect(whole).toContain('- [f_02] Probably vegetarian. (worked out from your conversations, not confirmed)');
  });

  it('tells the model an unconfirmed fact is read, or worked out from the person’s own words', async () => {
    const prompt = await promptWithAnInferredLine();
    const system = prompt.messages.find(message => message.role === 'system')?.content ?? '';
    expect(system).toContain(
      "A fact that was read, or worked out from the person's own words, not stated by the person",
    );
  });

  it('tells the model a fact the note itself does not carry is ignored, never filed', async () => {
    const prompt = await promptWithAnInferredLine();
    const system = prompt.messages.find(message => message.role === 'system')?.content ?? '';
    expect(system).toContain('A fact the note itself does not carry is ignored, never filed.');
  });
});
