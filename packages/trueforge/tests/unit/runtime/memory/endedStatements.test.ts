import { existsSync } from 'node:fs';
import path from 'node:path';

import { moveEndedStatements } from '../../../../src/runtime/memory/endedStatements';
import { VAULT_HISTORY_DIR } from '../../../../src/runtime/memory/vaultGit';
import { changeOptions, history, makeBase, pageWith, readPage, TODAY, writePage } from './nightlyTestKit';

describe('ended statements move to Earlier', () => {
  it('moves a line whose end day has passed, with that end day, as one history entry for all pages', async () => {
    const { vaultDir } = await makeBase();
    await writePage(
      vaultDir,
      'matter',
      'nora',
      pageWith({
        now: [
          '- Booked the movie. <!-- fact: id=f_01 src=mail since=2026-10-30 until=2026-11-01 -->',
          '- Dinner is at seven. <!-- fact: id=f_02 src=you_said since=2026-11-01 until=2026-11-10 -->',
        ],
      }),
    );
    await writePage(
      vaultDir,
      'matter',
      'the-move',
      pageWith({
        title: 'The move',
        open: ['- Pick a school. <!-- fact: id=f_03 src=you_said since=2026-10-01 until=2026-10 -->'],
      }),
    );

    const moved = await moveEndedStatements({ options: changeOptions(vaultDir) });

    expect(moved).toBe(3);
    const nora = await readPage(vaultDir, 'matter', 'nora');
    expect(nora).toMatch(
      /## Earlier\n- Booked the movie\. <!-- fact: id=f_01 src=mail since=2026-10-30 until=2026-11-01 -->/,
    );
    expect(nora).toContain(
      '- Dinner is at seven. <!-- fact: id=f_02 src=you_said since=2026-11-01 until=2026-11-10 -->',
    );
    expect(nora.indexOf('## Earlier')).toBeLessThan(nora.indexOf('Dinner is at seven'));
    expect(nora.indexOf('## Now')).toBeLessThan(nora.indexOf('## Open'));
    expect(history(vaultDir).filter(entry => entry.startsWith('Aman'))).toEqual([
      'Aman moved 3 ended lines to Earlier',
    ]);
  });

  it('keeps a line that ends today or later, and a month that is not over', async () => {
    const { vaultDir } = await makeBase();
    const content = pageWith({
      now: [
        `- Ends today. <!-- fact: id=f_01 src=you_said since=2026-11-01 until=${TODAY} -->`,
        '- Ends later. <!-- fact: id=f_02 src=you_said since=2026-11-01 until=2026-12-01 -->',
        '- Ends this month. <!-- fact: id=f_03 src=you_said since=2026-11-01 until=2026-11 -->',
        '- No end. <!-- fact: id=f_04 src=you_said since=2026-11-01 -->',
      ],
    });
    await writePage(vaultDir, 'matter', 'nora', content);

    expect(await moveEndedStatements({ options: changeOptions(vaultDir) })).toBe(0);
    expect(await readPage(vaultDir, 'matter', 'nora')).toBe(content);
  });

  it('leaves Unconfirmed and “How you write to them” alone', async () => {
    const { vaultDir } = await makeBase();
    const content = [
      '---',
      'kind: person',
      'title: Nora',
      '---',
      '# Nora',
      '',
      '## How you write to them',
      '- Short and casual. <!-- fact: id=f_01 src=sent_mail since=2026-01-01 until=2026-02-01 -->',
      '',
      '## Unconfirmed',
      '- Might travel. <!-- fact: id=f_02 src=read_content seen=2026-10-29 until=2026-10-30 -->',
      '',
      '## Earlier',
      '',
    ].join('\n');
    await writePage(vaultDir, 'person', 'nora', content);

    expect(await moveEndedStatements({ options: changeOptions(vaultDir) })).toBe(0);
    expect(await readPage(vaultDir, 'person', 'nora')).toBe(content);
  });

  it('writes nothing when nothing ended: no history entry, not even a history', async () => {
    const { vaultDir } = await makeBase();
    await writePage(
      vaultDir,
      'matter',
      'nora',
      pageWith({ now: ['- Fine. <!-- fact: id=f_01 src=you_said since=2026-11-01 -->'] }),
    );

    await moveEndedStatements({ options: changeOptions(vaultDir) });

    expect(existsSync(path.join(vaultDir, VAULT_HISTORY_DIR))).toBe(false);
  });
});
