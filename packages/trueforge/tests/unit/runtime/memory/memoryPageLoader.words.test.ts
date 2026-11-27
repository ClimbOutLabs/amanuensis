import { loadPagesForMessage } from '../../../../src/runtime/memory/memoryPageLoader';
import type { PageLine } from '../../../../src/runtime/memory/memoryPages';
import { makeVault, ownBullet, writeStatementPage } from './statementTestKit';

const TODAY = '2026-11-10';

async function load({
  vaultDir,
  message,
  skipLine,
}: {
  vaultDir: string;
  message: string;
  skipLine?: ((line: PageLine) => boolean) | undefined;
}) {
  return loadPagesForMessage({
    vaultDirs: [vaultDir],
    writeVaultDir: vaultDir,
    message,
    today: TODAY,
    maxPages: 3,
    maxTokens: 10_000,
    skipLine,
  });
}

describe('pages found by words when no name or meaning route finds one', () => {
  it('finds a matter page whose statement shares a word with the message', async () => {
    const vaultDir = await makeVault();
    await writeStatementPage({
      vaultDir,
      slug: 'workshop-repair',
      title: 'Workshop repair',
      kind: 'matter',
      summary: 'A motor sent back for repair.',
      sections: {
        Now: [ownBullet({ text: 'The package was delayed and the sender used an old label.', id: 'f_01' })],
      },
    });

    const { pages, stats } = await load({ vaultDir, message: 'The package is moving' });

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ kind: 'matter', slug: 'workshop-repair', reason: 'words' });
    expect(pages[0]?.text).toContain(
      '- The package was delayed and the sender used an old label. (you said, since 2026-01-01)',
    );
    expect(stats).toMatchObject({ loaded: 1, candidates: 1 });
  });

  it('finds a statement that lives only on a person page, under that person page', async () => {
    const vaultDir = await makeVault();
    await writeStatementPage({
      vaultDir,
      slug: 'mr-okafor',
      title: 'Mr Okafor',
      sections: {
        Now: [
          ownBullet({ text: 'A package for his stall was delayed after the sender used an old label.', id: 'f_02' }),
        ],
      },
    });

    const { pages } = await load({ vaultDir, message: 'The package is moving' });

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ kind: 'person', slug: 'mr-okafor', reason: 'words' });
    expect(pages[0]?.text).toContain('A package for his stall was delayed');
  });

  it('still finds the page when meaning had too little to judge against', async () => {
    const vaultDir = await makeVault();
    await writeStatementPage({
      vaultDir,
      slug: 'workshop-repair',
      title: 'Workshop repair',
      kind: 'matter',
      summary: 'A motor sent back for repair.',
      sections: {
        Now: [ownBullet({ text: 'The package was delayed and the sender used an old label.', id: 'f_01' })],
      },
    });

    const { pages } = await loadPagesForMessage({
      vaultDirs: [vaultDir],
      writeVaultDir: vaultDir,
      message: 'The package is moving',
      today: TODAY,
      maxPages: 3,
      maxTokens: 10_000,
      gate: { state: 'too_little' },
    });

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ kind: 'matter', slug: 'workshop-repair', reason: 'words' });
  });

  it('stays silent when the meaning gate judged the message and found nothing remembered', async () => {
    const vaultDir = await makeVault();
    await writeStatementPage({
      vaultDir,
      slug: 'workshop-repair',
      title: 'Workshop repair',
      kind: 'matter',
      summary: 'A motor sent back for repair.',
      sections: {
        Now: [ownBullet({ text: 'The package was delayed and the sender used an old label.', id: 'f_01' })],
      },
    });

    const { pages } = await loadPagesForMessage({
      vaultDirs: [vaultDir],
      writeVaultDir: vaultDir,
      message: 'The package is moving',
      today: TODAY,
      maxPages: 3,
      maxTokens: 10_000,
      gate: {
        state: 'judged',
        open: false,
        statements: [],
        notes: [],
        judgedNamespaces: new Set(),
        messageBest: 0.1,
        bar: 0.9,
      },
    });

    expect(pages).toHaveLength(0);
  });

  it('finds nothing when no statement shares a word with the message', async () => {
    const vaultDir = await makeVault();
    await writeStatementPage({
      vaultDir,
      slug: 'workshop-repair',
      title: 'Workshop repair',
      kind: 'matter',
      sections: {
        Now: [ownBullet({ text: 'The package was delayed and the sender used an old label.', id: 'f_01' })],
      },
    });

    const { pages } = await load({ vaultDir, message: 'What is the weather like today' });

    expect(pages).toEqual([]);
  });

  it('stays silent when a named page was already found', async () => {
    const vaultDir = await makeVault();
    await writeStatementPage({
      vaultDir,
      slug: 'workshop-repair',
      title: 'Workshop repair',
      kind: 'matter',
      sections: {
        Now: [ownBullet({ text: 'The bench was swept and the tools put away.', id: 'f_01' })],
      },
    });
    await writeStatementPage({
      vaultDir,
      slug: 'mr-okafor',
      title: 'Mr Okafor',
      sections: {
        Now: [
          ownBullet({ text: 'A package for his stall was delayed after the sender used an old label.', id: 'f_02' }),
        ],
      },
    });

    const { pages } = await load({ vaultDir, message: 'Tell me about Workshop repair and the package' });

    expect(pages.map(page => [page.title, page.reason])).toEqual([['Workshop repair', 'direct']]);
  });

  it('leaves out a statement the chat has excluded', async () => {
    const vaultDir = await makeVault();
    await writeStatementPage({
      vaultDir,
      slug: 'workshop-repair',
      title: 'Workshop repair',
      kind: 'matter',
      sections: {
        Now: [ownBullet({ text: 'The package was delayed and the sender used an old label.', id: 'f_01' })],
      },
    });

    const { pages } = await load({
      vaultDir,
      message: 'The package is moving',
      skipLine: line => line.kind === 'fact' && line.fact.marker.id === 'f_01',
    });

    expect(pages).toEqual([]);
  });
});
