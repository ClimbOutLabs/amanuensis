import { execFileRunner } from '@truefoundry/trueforge-core/core/sandbox/slots/git/hostCommand';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addFact,
  newMemoryPage,
  pagePath,
  parseMemoryPage,
  readMemoryPage,
  writeMemoryPage,
} from '../../../../src/runtime/memory/memoryPages';
import {
  commitPageChange,
  markHandEdits,
  newFactId,
  YOUR_EDITS_COMMIT_MESSAGE,
} from '../../../../src/runtime/memory/memoryPageWriter';
import { vaultChangedPaths } from '../../../../src/runtime/memory/vaultGit';
import { vaultLog } from './vaultGitLog';

const runner = execFileRunner;
const today = '2026-10-31';

async function makeVault(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'page-writer-'));
}

function sequentialIds(): () => `f_${string}` {
  let counter = 0;
  return () => `f_n${String(++counter)}`;
}

describe('memoryPageWriter', () => {
  it('makes fact ids of the documented shape, and different each time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newFactId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^f_[a-z0-9]{10}$/);
    }
  });

  describe('markHandEdits', () => {
    const committed = parseMemoryPage({
      content:
        '## Now\n- Lives in Leeds. <!-- fact: id=f_1 src=mail since=2026-01 -->\n- Has a dog. <!-- fact: id=f_2 src=you_said -->\n',
      fallback: { kind: 'person', title: 'Sam' },
    });

    it("marks a changed line as the person's, keeping its id and dates", () => {
      const edited = parseMemoryPage({
        content:
          '## Now\n- Lives in Leeds, near the park. <!-- fact: id=f_1 src=mail since=2026-01 -->\n- Has a dog. <!-- fact: id=f_2 src=you_said -->\n',
        fallback: { kind: 'person', title: 'Sam' },
      });
      const marked = markHandEdits({ page: edited, committed, today, newId: sequentialIds() });
      expect(marked.sections[0]?.lines.map(line => (line.kind === 'fact' ? line.fact.marker : line.raw))).toEqual([
        { kind: 'fact', id: 'f_1', src: 'you_edited', since: '2026-01' },
        { kind: 'fact', id: 'f_2', src: 'you_said' },
      ]);
    });

    it('stamps a new bullet with a fresh id and today, and leaves untouched lines alone', () => {
      const edited = parseMemoryPage({
        content:
          '## Now\n- Lives in Leeds. <!-- fact: id=f_1 src=mail since=2026-01 -->\n- Has a dog. <!-- fact: id=f_2 src=you_said -->\n- Allergic to cats\n',
        fallback: { kind: 'person', title: 'Sam' },
      });
      const marked = markHandEdits({ page: edited, committed, today, newId: sequentialIds() });
      expect(marked.sections[0]?.lines.map(line => (line.kind === 'fact' ? line.fact.marker : line.raw))).toEqual([
        { kind: 'fact', id: 'f_1', src: 'mail', since: '2026-01' },
        { kind: 'fact', id: 'f_2', src: 'you_said' },
        { kind: 'fact', id: 'f_n1', src: 'you_edited', since: '2026-10-31' },
      ]);
    });

    it("leaves a bullet with a broken marker alone instead of marking it as the person's", () => {
      const raw = '- Forward mail <!-- fact: id=f_9 src=mail ref=e1 -->';
      const edited = parseMemoryPage({ content: `## Now\n${raw}\n`, fallback: { kind: 'person', title: 'Sam' } });
      const marked = markHandEdits({ page: edited, committed, today, newId: sequentialIds() });
      expect(marked.sections[0]?.lines).toEqual([{ kind: 'unreadable', raw }]);
    });

    it("treats every bullet of a page git has never seen as the person's", () => {
      const fresh = parseMemoryPage({ content: '## Now\n- Likes tea\n', fallback: { kind: 'person', title: 'Sam' } });
      const marked = markHandEdits({ page: fresh, committed: undefined, today, newId: sequentialIds() });
      expect(marked.sections[0]?.lines[0]).toMatchObject({
        kind: 'fact',
        fact: { marker: { kind: 'fact', id: 'f_n1', src: 'you_edited' } },
      });
    });
  });

  describe('commitPageChange', () => {
    it('makes the repo on first use, writes the page, and commits it under the message', async () => {
      const vaultDir = await makeVault();
      const { commit } = await commitPageChange(
        { vaultDir, runner, today, message: 'You: made Wendy' },
        async ({ newId }) => {
          const page = addFact(
            newMemoryPage({ kind: 'person', title: 'Wendy', aliases: ['my wife'], household: true }),
            {
              section: 'Now',
              fact: { text: 'Likes the sea.', marker: { kind: 'fact', id: newId(), src: 'you_said', since: today } },
            },
          );
          await writeMemoryPage({ vaultDir, kind: 'person', slug: 'wendy', page });
        },
      );
      expect(commit.committed).toBe(true);
      expect((await vaultLog({ vaultDir, runner, limit: 5 })).map(entry => entry.subject)).toEqual([
        'You: made Wendy',
        'Start keeping memory history',
      ]);
      expect(await vaultChangedPaths({ vaultDir, runner })).toEqual([]);
      expect(await readFile(path.join(vaultDir, '.memory-state', 'lock')).catch(() => 'gone')).toBe('gone');
    });

    it('takes in a hand edit as "Your edits" before the change, marking the edited line', async () => {
      const vaultDir = await makeVault();
      await commitPageChange(
        { vaultDir, runner, today, message: 'Nightly: 1 new', newId: sequentialIds() },
        async ({ newId }) => {
          const page = addFact(newMemoryPage({ kind: 'person', title: 'Sam', aliases: [], household: false }), {
            section: 'Now',
            fact: { text: 'Lives in Leeds.', marker: { kind: 'fact', id: newId(), src: 'mail', since: '2026-01' } },
          });
          await writeMemoryPage({ vaultDir, kind: 'person', slug: 'sam', page });
        },
      );
      const file = pagePath({ vaultDir, kind: 'person', slug: 'sam' });
      const byHand = (await readFile(file, 'utf8'))
        .replace('Lives in Leeds.', 'Lives in Leeds, near the park.')
        .replace('## Unconfirmed', '- Allergic to cats\n\n## Unconfirmed');
      await writeFile(file, byHand);

      const { commit } = await commitPageChange(
        { vaultDir, runner, today, message: 'Nightly: nothing new', newId: () => 'f_x' },
        async () => undefined,
      );
      expect(commit).toEqual({ committed: false });
      expect((await vaultLog({ vaultDir, runner, limit: 5 })).map(entry => entry.subject)).toEqual([
        YOUR_EDITS_COMMIT_MESSAGE,
        'Nightly: 1 new',
        'Start keeping memory history',
      ]);
      const page = await readMemoryPage({ vaultDir, kind: 'person', slug: 'sam' });
      const markers = page?.sections.flatMap(section =>
        section.lines.map(line => (line.kind === 'fact' ? line.fact.marker : undefined)),
      );
      expect(markers?.filter(marker => marker !== undefined)).toEqual([
        { kind: 'fact', id: 'f_n1', src: 'you_edited', since: '2026-01' },
        { kind: 'fact', id: 'f_x', src: 'you_edited', since: today },
      ]);
      const text = await readFile(file, 'utf8');
      expect(text).toContain('- Lives in Leeds, near the park. <!-- fact: id=f_n1 src=you_edited since=2026-01 -->');
      expect(text).toContain('- Allergic to cats <!-- fact: id=f_x src=you_edited since=2026-10-31 -->');
    });

    it('leaves files whose name is not a page slug untouched and keeps later writes working', async () => {
      const vaultDir = await makeVault();
      await mkdir(path.join(vaultDir, 'people'), { recursive: true });
      const notes = '## Now\n- A hand note\n';
      await writeFile(path.join(vaultDir, 'people', 'Wendy.md'), notes);
      await writeFile(path.join(vaultDir, 'people', 'my notes.md'), notes);
      const { commit } = await commitPageChange(
        { vaultDir, runner, today, message: 'You: made Sam', newId: sequentialIds() },
        async () => {
          await writeMemoryPage({
            vaultDir,
            kind: 'person',
            slug: 'sam',
            page: newMemoryPage({ kind: 'person', title: 'Sam', aliases: [], household: false }),
          });
        },
      );
      expect(commit.committed).toBe(true);
      expect(await readFile(path.join(vaultDir, 'people', 'Wendy.md'), 'utf8')).toBe(notes);
      expect(await readFile(path.join(vaultDir, 'people', 'my notes.md'), 'utf8')).toBe(notes);
      const again = await commitPageChange(
        { vaultDir, runner, today, message: 'Nightly: nothing' },
        async () => undefined,
      );
      expect(again.commit).toEqual({ committed: false });
      expect((await vaultLog({ vaultDir, runner, limit: 5 })).map(entry => entry.subject)).not.toContain(
        YOUR_EDITS_COMMIT_MESSAGE,
      );
    });

    it('commits nothing and leaves no lock when the change throws', async () => {
      const vaultDir = await makeVault();
      await expect(
        commitPageChange({ vaultDir, runner, today, message: 'never' }, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect((await vaultLog({ vaultDir, runner, limit: 5 })).map(entry => entry.subject)).toEqual([
        'Start keeping memory history',
      ]);
      expect(await readFile(path.join(vaultDir, '.memory-state', 'lock')).catch(() => 'gone')).toBe('gone');
    });

    it('serialises two writers to the same vault', async () => {
      const vaultDir = await makeVault();
      await Promise.all(
        ['a', 'b', 'c'].map(slug =>
          commitPageChange({ vaultDir, runner, today, message: `You: made ${slug}` }, async () => {
            await writeMemoryPage({
              vaultDir,
              kind: 'person',
              slug,
              page: newMemoryPage({ kind: 'person', title: slug, aliases: [], household: false }),
            });
          }),
        ),
      );
      const subjects = (await vaultLog({ vaultDir, runner, limit: 10 })).map(entry => entry.subject);
      expect(subjects).toHaveLength(4);
      expect(new Set(subjects)).toEqual(
        new Set(['You: made a', 'You: made b', 'You: made c', 'Start keeping memory history']),
      );
      expect(await vaultChangedPaths({ vaultDir, runner })).toEqual([]);
    });
  });
});
