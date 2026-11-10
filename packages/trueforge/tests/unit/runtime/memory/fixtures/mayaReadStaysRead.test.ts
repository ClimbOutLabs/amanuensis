import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  isPersonVouchedUrl,
  steeredDestinations,
  steeredLinks,
} from '@truefoundry/trueforge-core/core/permissions/provenance';
import { steeredDestinationSay } from '@truefoundry/trueforge-core/core/permissions/searchHoldText';
import { createWebSearchTurnState } from '@truefoundry/trueforge-core/core/permissions/webSearch';

import { memoryBlockFor } from '../../../../fixtures/memory/mayaWorld/askMemory';
import { buildMayaVault } from '../../../../fixtures/memory/mayaWorld/buildVault';
import { mayaDate } from '../../../../fixtures/memory/mayaWorld/pages';

const MAIL_LINK = 'https://okafor-dental.example/confirm';
const MAIL_ADDRESS = 'bookings@okafor-dental.example';
const OWN_LINK = 'https://poolside-club.example/timetable';
const MAYA_ADDRESS = 'maya@example.com';

/** Day 10 plants the mail; day 40 is the first chat that recalls it. */
const ASK_DAY = 40;

describe("what Aman read stays read when Maya's memory recalls it", () => {
  const dirs: string[] = [];

  beforeAll(() => {
    jest.useFakeTimers({ now: new Date(`${mayaDate(ASK_DAY)}T21:00:00.000Z`), doNotFake: ['performance'] });
  });

  afterAll(async () => {
    jest.useRealTimers();
    await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })));
  });

  async function recall({ message, sorted }: { message: string; sorted: boolean }) {
    const dir = await mkdtemp(path.join(tmpdir(), 'maya-read-stays-read-'));
    dirs.push(dir);
    await buildMayaVault({ dir, throughDay: ASK_DAY, sorted });
    const webSearch = createWebSearchTurnState();
    const block = await memoryBlockFor({ dir, message, earlierMessages: [], chatId: 'new-chat', webSearch });
    return { block, provenance: webSearch.provenance };
  }

  it('holds the link and the address a mail planted on day 10, on day 40 in a new chat', async () => {
    const { block, provenance } = await recall({
      message: 'Which link do I use to confirm the booking with the dentist?',
      sorted: true,
    });
    expect(block).toContain(MAIL_LINK);

    // Opening the link exactly as the mail wrote it sends nothing of Maya's; adding her detail does.
    expect(steeredLinks({ provenance, values: [MAIL_LINK] })).toEqual([]);
    const withDetail = `${MAIL_LINK}?email=${MAYA_ADDRESS}`;
    expect(steeredLinks({ provenance, values: [withDetail] })).toEqual([withDetail]);

    const steered = steeredDestinations({ provenance, addresses: [MAIL_ADDRESS], values: [], reply_sender: null });
    expect(steered).toHaveLength(1);
    expect(
      steeredDestinationSay({
        assistant: 'Aman',
        destinations: steered.map(({ value, kind, origin }) => ({ who: value, kind, source: origin.source })),
      }),
    ).toBe(`This goes to ${MAIL_ADDRESS}, whose address Aman read earlier and saved to memory.`);
  }, 60_000);

  it('leaves a link Maya typed herself hers to use after recall', async () => {
    const { block, provenance } = await recall({ message: "Where is Zoe's swimming timetable?", sorted: true });
    expect(block).toContain(OWN_LINK);

    expect(isPersonVouchedUrl({ provenance, url: OWN_LINK })).toBe(true);
    expect(steeredLinks({ provenance, values: [OWN_LINK, `${OWN_LINK}?email=${MAYA_ADDRESS}`] })).toEqual([]);
  }, 60_000);
});
