import type { MemoryNoteSource } from '../../../../src/runtime/memory/memoryNotes';
import type { StoryLine } from './story';

/** A small seeded generator, so the filler is the same on every run and machine. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const TIMES = ['8:15', '9:45', '12:30', '15:15', '17:45', '19:30'];
const SHOPS = [
  'Larkspur Books',
  'Fennel & Rye',
  'Tidewater Outdoors',
  'Harbour Pharmacy',
  'Quill Stationery',
  'Maple Hardware',
  'Corner Cycle Shop',
  'Saffron Grocer',
  'Bluebell Florist',
  'Northside Garden Centre',
];
const ITEMS = [
  'two paperbacks',
  'a sourdough starter kit',
  'a rain jacket',
  'printer paper',
  'a set of wood screws',
  'a bike light',
  'olive oil and rice',
  'a bunch of tulips',
  'potting soil',
  'a desk lamp',
  'a water bottle',
  'a pack of notebooks',
];

const SAID = [
  ...['the ramen place on Elm Street', 'the new bakery by the station', 'the Georgian restaurant in town'].map(
    place => `Maya wants to try ${place}.`,
  ),
  ...[
    'a novel about a lighthouse keeper',
    'a history of the Silk Road',
    'a book of short stories',
    'a cycling memoir',
  ].map(book => `Maya is reading ${book}.`),
  ...['a long walk by the canal', 'the Sunday farmers market', 'a quiet evening with a film', 'an early swim'].map(
    thing => `Maya enjoyed ${thing} this week.`,
  ),
  ...['a standing desk', 'new running shoes', 'a second monitor', 'a cast-iron pan', 'a better office chair'].map(
    item => `Maya is thinking about buying ${item}.`,
  ),
  ...['a lentil curry', 'fresh pasta', 'a fish pie', 'a big pot of chilli', 'roast vegetables', 'dumplings'].map(
    dish => `Maya wants to cook ${dish} this weekend.`,
  ),
  ...['the river path', 'the old railway line', 'the park loop', 'the hill behind the school'].map(
    route => `Maya plans to go for a run along ${route}.`,
  ),
  'Maya slept badly and wants an easier day.',
  'Maya is trying to drink less coffee in the afternoon.',
  'Maya wants to tidy the garage one of these weekends.',
  'Maya thinks the office is too cold this month.',
  'Maya is pleased with how the garden tomatoes turned out.',
  'Maya wants to learn a little Spanish before the autumn.',
  'Maya is behind on her expense reports.',
  'Maya would like to get back into pottery.',
  'Maya found the morning commute slow all week.',
  'Maya wants to sort the family photos into albums.',
  'Maya is considering a weekend course in bread baking.',
  'Maya liked the podcast about city planning.',
  'Maya wants to walk to work more often.',
  'Maya is glad the heatwave is over.',
  'Maya wants to replace the hallway light bulb.',
  'Maya is curious about a book club at the library.',
  'Maya thinks the new team stand-up format works better.',
  'Maya wants to finish the jigsaw on the dining table.',
  'Maya is thinking about repainting the hallway.',
  'Maya wants to back up the laptop this weekend.',
  'Maya enjoyed the concert in the park.',
  'Maya is trying a new stretching routine for her back.',
  'Maya wants to plant bulbs before the first frost.',
  'Maya would like to host a small dinner for friends soon.',
  'Maya is thinking about a weekend away in the hills.',
  'Maya wants to cancel a streaming service she no longer uses.',
  'Maya found a good recipe for flatbread.',
  'Maya wants to clear her inbox by Friday.',
  'Maya is looking for a good raincoat.',
  'Maya thinks the neighbourhood needs a better bike lane.',
  'Maya wants to try the climbing wall again.',
  'Maya is enjoying a documentary series about oceans.',
  'Maya wants to get the bikes serviced.',
  'Maya would like a quieter desk at the office.',
];

const REPLIES = [
  ...[
    'how to descale a kettle',
    'how compound interest works',
    'the difference between baking soda and baking powder',
    'how to set up a shared family calendar',
    'why sourdough needs a long rise',
    'how to read a boiler pressure gauge',
    'how a filing extension differs from a payment extension',
    'how to export a spreadsheet as a PDF',
    'what a pivot table does',
    'how to share a large file by link',
    'how to mute a group chat for a week',
    'what to pack for a rainy city weekend',
    'how to stop tomatoes from splitting',
    'how tile grout cures',
    'how to bleed a radiator',
  ].map(topic => `Explained ${topic}.`),
  ...[
    'a reply to Priya about the offsite agenda',
    'a short note to the team about the new stand-up time',
    'a shopping list for the week',
    'a thank-you note for the neighbours',
    'a packing list for a weekend away',
    'a checklist for the school run',
    'an agenda for the pricing review',
    'a message to the building manager about the bins',
    'a polite reminder about an unpaid expense claim',
    'a reading plan for the month',
    'a one-page summary of the client meeting',
    'a list of questions for the architect',
    'a birthday message for a colleague',
    'a note to Sam Whitfield about the dashboard',
    'a meal plan with two vegetarian nights',
  ].map(doc => `Drafted ${doc}.`),
  ...[
    'five easy weeknight dinners',
    'three podcasts about design',
    'four day trips by train',
    'the documents usually needed for a tax return',
    'things to check before a boiler service',
    'six picture books about space',
    'ways to keep a cast dry in the shower',
    'four museums that open late',
    'questions to ask a new dentist',
    'three ways to track shared expenses',
    'snacks that are safe for a nut-free classroom',
    'common mistakes in a budget table',
    'three stretches for a stiff back',
    'tapas dishes worth trying',
    'ways to keep a proposal short',
  ].map(list => `Listed ${list}.`),
  ...[
    'the meeting notes from the pricing review',
    'a long article about remote work',
    'the school newsletter',
    'the terms of the hotel booking',
    'the warranty leaflet for the boiler',
    'a report on customer churn',
    'the minutes of the residents meeting',
    'a guide to the city bike scheme',
    'the instructions for the new oven',
    'a thread about the office move',
  ].map(thing => `Summarised ${thing}.`),
  ...[
    'three gift ideas for Nora',
    'a route for a Sunday bike ride',
    'two ways to phrase a deadline reminder',
    'a seating plan for a dinner of eight',
    'a rainy-day plan for a seven-year-old',
    'three names for the proposal deck',
    'a simple filing system for receipts',
    'a quieter time for the weekly review',
    'a few games for a long car journey',
    'a present for a new baby',
  ].map(idea => `Suggested ${idea}.`),
  ...[
    'two project trackers',
    'three brands of running shoes',
    'two train routes to the coast',
    'fixed and variable mortgage rates in general terms',
    'two ways to lay kitchen tiles',
    'paper and digital planners',
    'three note-taking apps',
    'two kinds of travel insurance',
  ].map(pair => `Compared ${pair}.`),
];

const PEOPLE_MAIL = [
  'Sam Whitfield shared the dashboard link for the weekly numbers.',
  'Sam Whitfield asked who is bringing snacks to the team lunch.',
  'Sam Whitfield forwarded a long thread about the office move.',
  'Priya Nair sent the agenda for the team meeting.',
  'Priya Nair thanked the team for a smooth quarter close.',
  'Priya Nair shared a reading list on pricing strategy.',
  'Nora forwarded a recipe for lentil soup.',
  'Nora forwarded a voucher for the garden centre.',
  'Nora sent a photo of a chair she likes.',
  'Tomás sent photos from a hike in the Sierra.',
  'Tomás recommended a film about a village bakery.',
  'Elena sent a photo of her garden.',
  'Elena asked for the recipe for the plum cake.',
  'Noor Haddad sent the class newsletter.',
  'Noor Haddad reminded parents to label water bottles.',
  "Marcus Bell's office sent a reminder to keep receipts.",
  "Marcus Bell's office sent its holiday opening hours.",
  'Aiko Tanaka left a note about a parcel she took in.',
  'Aiko Tanaka asked to borrow the tall ladder.',
  '김민수 sent the meeting notes from the last Halvorsen call.',
  '김민수 thanked Maya for the quick answers on scope.',
  'Δήμητρα Παππά sent photos of the tiling progress.',
  'Δήμητρα Παππά asked which handle finish the family prefers.',
  'Sam Rossi sent a leaflet about boiler servicing.',
  'Sam Rossi wrote that he is running twenty minutes late.',
  "The school office sent the lunch menu for Zoe's class.",
  "The swimming club sent a reminder to bring goggles for Zoe's class.",
  "Nora's cousin sent a group photo from the wedding.",
  'The residents group asked for volunteers for the street party.',
  'The library wrote that a reserved book is ready to collect.',
];

const EVENTS = [
  'Team stand-up',
  'Pricing review',
  'Yoga class',
  'Bin collection',
  'Design critique',
  'Quarterly planning',
  'Coffee with the new hire',
  'Bike service',
  'Window cleaner',
  'Book club',
  'All-hands meeting',
  'Hair appointment',
  'Residents meeting',
  'Client check-in',
  'Lunch with the old team',
];

const PLACES = [
  'The city library',
  'The farmers market',
  'The swimming pool',
  'The recycling centre',
  'The post office on Harbour Street',
  'The garden centre',
  'The climbing wall',
  'The bakery by the station',
  'The hardware shop',
  'The science museum',
];

interface FillerPlan {
  source: MemoryNoteSource | undefined;
  why: string;
  next: (random: () => number) => string;
}

function pick<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) {
    throw new Error('filler pool is empty');
  }
  return item;
}

const PLANS: readonly FillerPlan[] = [
  {
    source: undefined,
    why: 'A passing remark about the owner, not about a person or a matter.',
    next: r => pick(SAID, r),
  },
  {
    source: 'assistant_response',
    why: 'What the assistant said is not a fact about anyone.',
    next: r => pick(REPLIES, r),
  },
  {
    source: 'assistant_response',
    why: 'What the assistant said is not a fact about anyone.',
    next: r => pick(REPLIES, r),
  },
  {
    source: 'email',
    why: 'Routine mail with nothing lasting in it.',
    next: r => `${pick(SHOPS, r)} sent a receipt for ${pick(ITEMS, r)}.`,
  },
  { source: 'email', why: 'Routine mail with nothing lasting in it.', next: r => pick(PEOPLE_MAIL, r) },
  {
    source: 'email',
    why: 'A delivery notice is over once the parcel arrives.',
    next: r => `The parcel from ${pick(SHOPS, r)} arrives on ${pick(WEEKDAYS, r)}.`,
  },
  {
    source: 'calendar',
    why: 'A routine calendar entry, not a fact about a person or a matter.',
    next: r => `${pick(EVENTS, r)} on ${pick(WEEKDAYS, r)} at ${pick(TIMES, r)}.`,
  },
  {
    source: 'web',
    why: 'General information from the web.',
    next: r =>
      `${pick(PLACES, r)} is open from ${pick(['7:30', '8:00', '9:00'], r)} to ${pick(['17:00', '18:30', '20:00'], r)}.`,
  },
];

/**
 * The everyday noise around the story: six to eight more entries of mixed kinds for each day, placed
 * after that day's story entries. No line is used twice, so each one is its own entry to find or to skip.
 */
export function mayaFiller({
  storyCounts,
  seed,
}: {
  storyCounts: ReadonlyMap<number, number>;
  seed: number;
}): StoryLine[] {
  const random = seeded(seed);
  const used = new Set<string>();
  const lines: StoryLine[] = [];
  for (const [day, storyCount] of storyCounts) {
    const extra = 6 + Math.floor(random() * 3);
    let place = storyCount;
    for (let offset = 0; offset < extra; offset += 1) {
      const plan = PLANS[(day + offset) % PLANS.length];
      if (plan === undefined) {
        continue;
      }
      let text = plan.next(random);
      for (let attempt = 0; used.has(text) && attempt < 50; attempt += 1) {
        text = plan.next(random);
      }
      if (used.has(text)) {
        continue;
      }
      used.add(text);
      place += 1;
      lines.push({
        at: [day, place],
        source: plan.source,
        text,
        then: [{ decision: 'ignore', reason: plan.why }],
      });
    }
  }
  return lines;
}
