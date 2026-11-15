import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import type { RetainItem } from '../../../../src/runtime/memory/memoryClient';

const MESSAGE =
  "Hi June, remember Nora's is coming up in December in India and I wont be able to attend. Can you come up with 3 gift ideas and create a space for me";

// Long background notes that share many words with the question ("and", "for", "with", "can",
// "you", "come", "able", "space", "ideas", "create") without being about it.
const BACKGROUND_NOTES = [
  'Photo gear for Lisbon: I can carry the small camera and two lenses, comfortable for long walks, with space in the bag for a tripod and ideas for a street series you can create over a year.',
  'GP shortlist for Lisbon: three clinics you can reach by tram, with evening hours and English-speaking staff, comfortable waiting rooms, and space for walk-ins; ideas for questions to ask when I create the first appointment.',
  'Rental budget for Lisbon: comfortable with 1400 for a one-bedroom and willing to come up to 1600 for a place with office space; ideas for neighborhoods you can walk to the river from, and create a shortlist.',
  'Fado evenings in Lisbon: the small houses in Alfama are affordable and you can come late; space is tight, so book with a friend, and keep ideas for places to create a regular routine.',
  'Language plan for Lisbon: comfortable with reading menus and signs, able to order coffee, and want ideas for classes you can attend twice a week with space for homework; create flashcards for verbs.',
  'Coworking in Lisbon: three spaces with day passes you can buy at the door and quiet rooms for calls; comfortable chairs, ideas for a monthly plan, and create a budget line for it.',
  'Weekend trips from Lisbon: Sintra and Cascais are reachable by train and you can come back the same day; ideas for a longer trip with space for hiking gear, and create a packing list.',
  'Cooking in Lisbon: the market near the apartment has fish and vegetables you can buy daily; comfortable with simple recipes, ideas for dinners with friends, and create a weekly shopping list with space for treats.',
  'Bike routes in Lisbon: the riverside path is flat and comfortable, and you can ride to Belem with space for a picnic; ideas for hill routes once fitness allows, and create a rainy-day backup plan.',
  'Furniture for the Lisbon flat: a desk with space for two screens, a comfortable chair you can adjust, and shelves for books; ideas for second-hand shops, and create a list of measurements before buying.',
];

const NORA_NOTES = [
  "Maya's really good friend is Nora.",
  "Maya won't be able to attend Nora's in December 2026 in India.",
];

describe('MarkdownMemoryClient recall ranks notes naming the person asked about first', () => {
  it('keeps both Nora notes in the top ten despite long background notes sharing more words', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mdnames-'));
    try {
      const client = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-1' });
      await client.retain({
        items: [
          ...BACKGROUND_NOTES.map((content, index): RetainItem => ({
            content,
            timestamp: `2026-10-${String(10 + index).padStart(2, '0')}T09:00:00Z`,
            document_id: `bg-${String(index)}`,
            metadata: { origin: 'user_stated' },
          })),
          ...NORA_NOTES.map((content, index): RetainItem => ({
            content,
            timestamp: `2026-10-28T1${String(index)}:00:00Z`,
            document_id: `nora-${String(index)}`,
            metadata: { origin: 'user_stated' },
          })),
        ],
        operationId: 'op-1',
        timeoutMs: 5000,
      });

      const outcome = await client.recall({
        query: MESSAGE,
        maxTokens: 600,
        timeoutMs: 5000,
      });
      if (!outcome.ok) {
        throw new Error(outcome.reason);
      }
      const topTen = outcome.results.slice(0, 10).map(item => item.text);
      expect(topTen.filter(text => text.includes('Nora'))).toHaveLength(2);
      expect(topTen[0]).toContain('Nora');
      expect(topTen[1]).toContain('Nora');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
