import { statementWordCandidates } from '../../../../src/runtime/memory/statementWordCandidates';
import { makeVault, ownBullet, writeStatementPage } from './statementTestKit';

const TODAY = '2026-11-10';

async function candidates({ vaultDir, message, limit = 4 }: { vaultDir: string; message: string; limit?: number }) {
  return statementWordCandidates({ vaultDirs: [vaultDir], message, today: TODAY, limit });
}

describe('statementWordCandidates', () => {
  it('returns the matching statement with its page reference and fact id', async () => {
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

    const found = await candidates({ vaultDir, message: 'The package is moving' });

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: 'matter',
      slug: 'workshop-repair',
      title: 'Workshop repair',
      excerpt: 'The package was delayed and the sender used an old label.',
      factId: 'f_01',
      matchedTerms: ['package'],
    });
  });

  it('keeps a statement on a person page a person statement, not a matter', async () => {
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

    const found = await candidates({ vaultDir, message: 'The package is moving' });

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'person', slug: 'mr-okafor' });
  });

  it('gives a hand-typed bullet no fact id', async () => {
    const vaultDir = await makeVault();
    await writeStatementPage({
      vaultDir,
      slug: 'workshop-repair',
      title: 'Workshop repair',
      kind: 'matter',
      sections: { Now: ['- The package shelf was swept on Friday.'] },
    });

    const found = await candidates({ vaultDir, message: 'The package is moving' });

    expect(found).toHaveLength(1);
    expect(found[0]?.factId).toBeUndefined();
  });

  it('ranks a statement matched by a distinctive word above one matched by a common word', async () => {
    const vaultDir = await makeVault();
    await writeStatementPage({
      vaultDir,
      slug: 'workshop-repair',
      title: 'Workshop repair',
      kind: 'matter',
      sections: {
        Now: [
          ownBullet({ text: 'The carburetor kit arrived for the bench.', id: 'f_01' }),
          ownBullet({ text: 'The package was left by the side door.', id: 'f_02' }),
          ownBullet({ text: 'A package of filters sits on the shelf.', id: 'f_03' }),
          ownBullet({ text: 'The package labels were reprinted.', id: 'f_04' }),
          ownBullet({ text: 'The bench was swept after lunch.', id: 'f_05' }),
          ownBullet({ text: 'A stool by the window needs a new leg.', id: 'f_06' }),
          ownBullet({ text: 'The kettle in the corner still works.', id: 'f_07' }),
          ownBullet({ text: 'Rain came through the skylight once.', id: 'f_08' }),
        ],
      },
    });

    const found = await candidates({ vaultDir, message: 'The package and the carburetor are here' });

    expect(found.map(candidate => candidate.factId)).toEqual(['f_01', 'f_02', 'f_03', 'f_04']);
    expect(found[0]?.matchedTerms).toEqual(['carburetor']);
  });

  it('holds the limit, best first', async () => {
    const vaultDir = await makeVault();
    await writeStatementPage({
      vaultDir,
      slug: 'workshop-repair',
      title: 'Workshop repair',
      kind: 'matter',
      sections: {
        Now: [
          ownBullet({ text: 'The carburetor kit arrived for the bench.', id: 'f_01' }),
          ownBullet({ text: 'The package was left by the side door.', id: 'f_02' }),
          ownBullet({ text: 'A package of filters sits on the shelf.', id: 'f_03' }),
          ownBullet({ text: 'The bench was swept after lunch.', id: 'f_04' }),
          ownBullet({ text: 'A stool by the window needs a new leg.', id: 'f_05' }),
          ownBullet({ text: 'The kettle in the corner still works.', id: 'f_06' }),
        ],
      },
    });

    const found = await candidates({ vaultDir, message: 'The package and the carburetor are here', limit: 2 });

    expect(found.map(candidate => candidate.factId)).toEqual(['f_01', 'f_02']);
  });

  it('offers nothing when the only shared word is in most statements', async () => {
    const vaultDir = await makeVault();
    await writeStatementPage({
      vaultDir,
      slug: 'workshop-repair',
      title: 'Workshop repair',
      kind: 'matter',
      sections: {
        Now: [
          ownBullet({ text: 'The package was delayed at the depot.', id: 'f_01' }),
          ownBullet({ text: 'The package needs a stronger box.', id: 'f_02' }),
          ownBullet({ text: 'A package of screws is missing.', id: 'f_03' }),
          ownBullet({ text: 'The package shelf was swept.', id: 'f_04' }),
        ],
      },
    });

    expect(await candidates({ vaultDir, message: 'The package is moving' })).toEqual([]);
  });

  it('offers nothing when no statement shares a word with the message', async () => {
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

    expect(await candidates({ vaultDir, message: 'What is the weather like today' })).toEqual([]);
  });

  it('leaves out a statement that ended long ago, and offers it when the message asks about the past', async () => {
    const vaultDir = await makeVault();
    await writeStatementPage({
      vaultDir,
      slug: 'workshop-repair',
      title: 'Workshop repair',
      kind: 'matter',
      sections: {
        Now: [ownBullet({ text: 'The package was stored at the depot.', id: 'f_01', until: '2026-01-15' })],
      },
    });

    expect(await candidates({ vaultDir, message: 'The package is moving' })).toEqual([]);
    const past = await candidates({ vaultDir, message: 'Where did the package used to be stored' });
    expect(past.map(candidate => candidate.factId)).toEqual(['f_01']);
  });

  it('returns the same words on the same page once', async () => {
    const vaultDir = await makeVault();
    await writeStatementPage({
      vaultDir,
      slug: 'workshop-repair',
      title: 'Workshop repair',
      kind: 'matter',
      sections: {
        Now: [
          ownBullet({ text: 'The package was delayed at the depot.', id: 'f_01' }),
          ownBullet({ text: 'The bench was swept after lunch.', id: 'f_03' }),
          ownBullet({ text: 'The kettle in the corner still works.', id: 'f_04' }),
        ],
        Decided: [ownBullet({ text: 'The package was delayed at the depot.', id: 'f_02' })],
      },
    });

    const found = await candidates({ vaultDir, message: 'The package is moving' });

    expect(found).toHaveLength(1);
  });

  it('leaves out lines the chat has excluded', async () => {
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

    const found = await statementWordCandidates({
      vaultDirs: [vaultDir],
      message: 'The package is moving',
      today: TODAY,
      limit: 4,
      skipLine: line => line.kind === 'fact' && line.fact.marker.id === 'f_01',
    });

    expect(found).toEqual([]);
  });
});
