import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chunkNote, countNoteFiles, scanNotesFolder } from '../../../../src/runtime/notesFolder/notesFolderScan';

async function makeVault(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'notes-scan-'));
  const vault = path.join(root, 'vault');
  await mkdir(path.join(vault, 'Projects'), { recursive: true });
  await mkdir(path.join(vault, '.obsidian'), { recursive: true });
  await writeFile(path.join(vault, 'Garden.md'), '# Garden\n\nWater the tomatoes.\n');
  await writeFile(path.join(vault, 'Projects', 'Ideas.md'), '# Ideas\n\nA better mousetrap.\n');
  await writeFile(path.join(vault, '.obsidian', 'config.md'), '# Hidden\n\nNot a note.\n');
  await writeFile(path.join(vault, '.draft.md'), '# Hidden file\n\nNot a note.\n');
  await writeFile(path.join(vault, 'photo.png'), 'not markdown');
  await writeFile(path.join(root, 'outside.md'), '# Outside\n\nLives outside the vault.\n');
  await symlink(path.join(root, 'outside.md'), path.join(vault, 'Linked.md'));
  return vault;
}

describe('scanning the notes folder', () => {
  it('finds the Markdown notes in path order and leaves hidden, non-note and linked-out files alone', async () => {
    const vault = await makeVault();
    const notes = await scanNotesFolder(vault);
    expect(notes.map(note => note.relativePath)).toEqual(['Garden.md', 'Projects/Ideas.md']);
    expect(await countNoteFiles(vault)).toBe(2);
  });

  it('reads as empty when the folder is not there', async () => {
    expect(await scanNotesFolder(path.join(tmpdir(), 'notes-scan-missing-folder'))).toEqual([]);
    expect(await countNoteFiles(path.join(tmpdir(), 'notes-scan-missing-folder'))).toBe(0);
  });
});

describe('chunking a note', () => {
  it('keeps the heading a chunk sits under and leaves frontmatter out', () => {
    const chunks = chunkNote({
      relativePath: 'Trips.md',
      content:
        '---\ntags: travel\n---\nIntro words.\n\n# Lisbon\n\nTram 28 and custard tarts.\n\n# Porto\n\nThe river at dusk.\n',
    });
    expect(chunks.map(chunk => ({ heading: chunk.heading, text: chunk.text }))).toEqual([
      { heading: null, text: 'Intro words.' },
      { heading: 'Lisbon', text: 'Tram 28 and custard tarts.' },
      { heading: 'Porto', text: 'The river at dusk.' },
    ]);
    expect(chunks.map(chunk => chunk.id)).toEqual(['Trips.md#0', 'Trips.md#1', 'Trips.md#2']);
  });

  it('splits a long section into more than one chunk', () => {
    const paragraph = 'word '.repeat(400).trim();
    const chunks = chunkNote({ relativePath: 'Long.md', content: `# Long\n\n${paragraph}\n` });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.heading === 'Long')).toBe(true);
    expect(chunks.map(chunk => chunk.text).join('')).toBe(paragraph);
  });
});
