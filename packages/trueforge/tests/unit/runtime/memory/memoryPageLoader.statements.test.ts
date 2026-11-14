import { loadPagesForMessage, renderPageForModel } from '../../../../src/runtime/memory/memoryPageLoader';
import { parseMemoryPage } from '../../../../src/runtime/memory/memoryPages';
import { askAbout, gateFor, HandChosenModel, makeVault, ownBullet, writeStatementPage } from './statementTestKit';

const TODAY = '2026-11-10';
const ASK = askAbout({ topic: 2, closeness: 0.5 });

/** Five statements about other topics, so the index is big enough to be trusted. */
async function writeFiller(vaultDir: string): Promise<void> {
  await writeStatementPage({
    vaultDir,
    slug: 'rita',
    title: 'Rita',
    summary: 'A colleague.',
    sections: {
      Now: [0, 1, 3, 4, 5].map(topic =>
        ownBullet({ text: `Mentions topic${String(topic)}.`, id: `f_0${String(topic)}` }),
      ),
    },
  });
}

async function load({
  vaultDir,
  message = ASK,
  earlierMessages = [],
}: {
  vaultDir: string;
  message?: string;
  earlierMessages?: string[];
}) {
  return loadPagesForMessage({
    vaultDirs: [vaultDir],
    writeVaultDir: vaultDir,
    message,
    earlierMessages,
    gate: await gateFor({ vaultDir, model: new HandChosenModel(), message }),
    today: TODAY,
    maxPages: 3,
    maxTokens: 10_000,
  });
}

describe('statements found by meaning', () => {
  it('shows a statement of an unnamed page under that page with its section label', async () => {
    const vaultDir = await makeVault();
    await writeFiller(vaultDir);
    await writeStatementPage({
      vaultDir,
      slug: 'sam',
      title: 'Sam',
      summary: 'The plumber.',
      sections: {
        Now: [ownBullet({ text: 'Fixes topic2 pipes.', id: 'f_20' }), ownBullet({ text: 'Has a van.', id: 'f_21' })],
      },
    });

    const { pages, stats } = await load({ vaultDir });

    expect(pages).toHaveLength(1);
    expect(pages[0]?.reason).toBe('meaning');
    expect(pages[0]?.drafting).toEqual([]);
    expect(pages[0]?.text.split('\n')).toEqual([
      '[page: Sam — person]',
      'The plumber.',
      'Now:',
      '- Fixes topic2 pipes. (you said, since 2026-01-01)',
    ]);
    expect(stats).toMatchObject({ loaded: 1, candidates: 1 });
  });

  it('keeps a read statement on the read side and a confirmed one on the persons side', async () => {
    const vaultDir = await makeVault();
    await writeFiller(vaultDir);
    await writeStatementPage({
      vaultDir,
      slug: 'sam',
      title: 'Sam',
      sections: {
        Now: [ownBullet({ text: 'Fixes topic2 pipes.', id: 'f_20' })],
        Unconfirmed: ['- Maybe topic2 too. <!-- fact: id=f_21 src=read_content seen=2026-10-01 -->'],
      },
    });

    const [page] = (await load({ vaultDir })).pages;

    expect(page?.ownLines).toContain('- Fixes topic2 pipes. (you said, since 2026-01-01)');
    expect(page?.readLines).toContain('- Maybe topic2 too. (read content, not confirmed, seen 2026-10-01)');
    expect(page?.holdsOutsideText).toBe(true);
  });

  it('puts the header of a page whose name is not the persons own on the read side, and keeps their own name on theirs', async () => {
    const vaultDir = await makeVault();
    await writeFiller(vaultDir);
    await writeStatementPage({
      vaultDir,
      slug: 'harbour-dental',
      title: 'Harbour Dental',
      sections: { Now: ['- Does topic2 checks. <!-- fact: id=f_30 src=read_content since=2026-10-01 -->'] },
    });
    await writeStatementPage({
      vaultDir,
      slug: 'sam',
      title: 'Sam',
      sections: { Now: [ownBullet({ text: 'Fixes topic2 pipes.', id: 'f_20' })] },
    });

    const { pages } = await load({ vaultDir });
    const read = pages.find(page => page.text.includes('Harbour Dental'));
    const own = pages.find(page => page.text.includes('Sam'));

    expect(read?.readLines).toContain('[page: Harbour Dental — person, name not confirmed by you]');
    expect(read?.ownLines).toEqual([]);
    expect(own?.ownLines).toContain('[page: Sam — person]');
    expect(own?.readLines).toEqual([]);
  });

  it('does not repeat statements of a page shown whole', async () => {
    const vaultDir = await makeVault();
    await writeFiller(vaultDir);
    await writeStatementPage({
      vaultDir,
      slug: 'sam',
      title: 'Sam',
      sections: { Now: [ownBullet({ text: 'Fixes topic2 pipes.', id: 'f_20' })] },
    });
    await writeStatementPage({
      vaultDir,
      slug: 'zoe',
      title: 'Zoe',
      sections: { Now: [ownBullet({ text: 'Likes topic2 games.', id: 'f_30' })] },
    });

    const { pages } = await load({ vaultDir, earlierMessages: ['Tell me about Sam.'] });

    expect(pages.map(page => [page.title, page.reason])).toEqual([
      ['Sam', 'direct'],
      ['Zoe', 'meaning'],
    ]);
    expect(
      pages
        .map(page => page.text)
        .join('\n')
        .match(/Fixes topic2 pipes/g),
    ).toHaveLength(1);
  });

  it('shows at most 6 statements', async () => {
    const vaultDir = await makeVault();
    await writeFiller(vaultDir);
    await writeStatementPage({
      vaultDir,
      slug: 'sam',
      title: 'Sam',
      sections: {
        Now: Array.from({ length: 9 }, (_, i) =>
          ownBullet({ text: `Fact ${String(i)} about topic2.`, id: `f_4${String(i)}` }),
        ),
      },
    });

    const { pages } = await load({ vaultDir });

    expect(pages.flatMap(page => page.text.split('\n')).filter(line => line.startsWith('- '))).toHaveLength(6);
  });

  it('shows the same statement text once even when two sections hold it', async () => {
    const vaultDir = await makeVault();
    await writeFiller(vaultDir);
    await writeStatementPage({
      vaultDir,
      slug: 'sam',
      title: 'Sam',
      sections: {
        Now: [ownBullet({ text: 'Fixes topic2 pipes.', id: 'f_20' })],
        Earlier: [ownBullet({ text: 'Fixes topic2 pipes.', id: 'f_21', until: '2026-11-01' })],
      },
    });

    const { pages } = await load({ vaultDir });

    expect(
      pages
        .map(page => page.text)
        .join('\n')
        .match(/Fixes topic2 pipes/g),
    ).toHaveLength(1);
  });

  describe('statements that have ended', () => {
    async function shown(message: string, until: string): Promise<string> {
      const vaultDir = await makeVault();
      await writeFiller(vaultDir);
      await writeStatementPage({
        vaultDir,
        slug: 'sam',
        title: 'Sam',
        sections: { Now: [ownBullet({ text: 'Lived near topic2.', id: 'f_20', until })] },
      });
      return (await load({ vaultDir, message })).pages.map(page => page.text).join('\n');
    }

    it('leaves out one that ended long ago', async () => {
      expect(await shown(ASK, '2026-01-15')).toBe('');
    });

    it('shows one that ended 10 days ago, under Earlier', async () => {
      const text = await shown(ASK, '2026-10-31');
      expect(text.split('\n')).toContain('Earlier:');
      expect(text).toContain('- Lived near topic2. (you said, 2026-01-01 to 2026-10-31)');
    });

    it('shows one that ended long ago when the message says "used to"', async () => {
      expect(await shown(`${ASK} where did we used to live`, '2026-01-15')).toContain('Lived near topic2.');
    });
  });
});

describe('end dates on a page', () => {
  const content = (until: string): string =>
    `---\nkind: person\ntitle: Sam\n---\n# Sam\n\n## Now\n- Away. <!-- fact: id=f_01 src=you_said since=2026-11-01 until=${until} -->\n`;

  function render(until: string): string[] {
    const page = parseMemoryPage({ content: content(until), fallback: { kind: 'person', title: 'Sam' } });
    return renderPageForModel({ title: 'Sam', page, today: TODAY }).split('\n');
  }

  it('shows a Now statement that ended yesterday under Earlier', () => {
    expect(render('2026-11-09')).toEqual([
      '[page: Sam — person]',
      'Earlier:',
      '- Away. (you said, 2026-11-01 to 2026-11-09)',
    ]);
  });

  it('keeps a statement whose end date is today as current', () => {
    expect(render('2026-11-10')).toEqual([
      '[page: Sam — person]',
      'Now:',
      '- Away. (you said, 2026-11-01 to 2026-11-10)',
    ]);
  });
});
