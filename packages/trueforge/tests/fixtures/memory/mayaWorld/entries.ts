import { z } from 'zod';

import { TOOL_INGESTED_ORIGIN, USER_STATED_ORIGIN } from '../../../../src/runtime/memory/memoryOrigin';
import { mayaFiller } from './filler';
import { mayaDate } from './pages';
import { MAYA_WORLD_DAYS, MayaEntrySchema, type MayaEntry } from './schema';
import { MAYA_STORY, type StoryLine } from './story';

const FILLER_SEED = 20260801;

function two(value: number): string {
  return String(value).padStart(2, '0');
}

function entryOf(line: StoryLine): unknown {
  const [day, place] = line.at;
  // Entries of a day are spread from early morning to evening, a few to a chat.
  const minutes = 7 * 60 + place * 47;
  const base = {
    id: idOf(line),
    day,
    timestamp: `${mayaDate(day)}T${two(Math.floor(minutes / 60))}:${two(minutes % 60)}:00.000Z`,
    session: `maya-d${two(day)}-c${String(Math.ceil(place / 3))}`,
    content: line.text,
    expected: line.then,
  };
  return line.source === undefined
    ? { ...base, origin: USER_STATED_ORIGIN }
    : { ...base, origin: TOOL_INGESTED_ORIGIN, note_source: line.source };
}

function storyCounts(): Map<number, number> {
  const counts = new Map<number, number>();
  for (let day = 1; day <= MAYA_WORLD_DAYS; day += 1) {
    counts.set(day, MAYA_STORY.filter(line => line.at[0] === day).length);
  }
  return counts;
}

function idOf(line: StoryLine): string {
  return `d${two(line.at[0])}_e${two(line.at[1])}`;
}

/** The ids of the hand-written entries; every other entry is everyday noise. */
export const MAYA_STORY_IDS: ReadonlySet<string> = new Set(MAYA_STORY.map(idOf));

/** Sixty days of Maya's daily log, oldest first: the hand-written story, then each day's everyday noise. */
export const MAYA_ENTRIES: readonly MayaEntry[] = z
  .array(MayaEntrySchema)
  .parse([...MAYA_STORY, ...mayaFiller({ storyCounts: storyCounts(), seed: FILLER_SEED })].map(entryOf))
  .sort((a, b) => a.id.localeCompare(b.id));
