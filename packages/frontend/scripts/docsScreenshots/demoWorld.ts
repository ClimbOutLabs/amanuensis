/** The made-up person and their things that every docs screenshot shows: Sam Rivera and their assistant, Aman. */
import { MORNING_BRIEF_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';

import type { DemoExchange } from './demoModelServer.ts';

export const OWNER = { name: 'Sam Rivera', firstName: 'Sam', email: 'sam@example.com' };
/** Only the screenshot run signs in with it, on a server that lives for the run. */
export const OWNER_PASSWORD = 'a long demo password';
export const ASSISTANT_NAME = 'Aman';
export const TIME_ZONE = 'America/Chicago';

/** A well-known provider type shows its own logo; its address points at the local demo model instead. */
export const PROVIDER = {
  type: 'together',
  models: [
    { model_id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'llama-3-3-70b' },
    { model_id: 'Qwen/Qwen3-32B', name: 'qwen3-32b' },
  ],
} as const;
export const MAIN_MODEL = `${PROVIDER.type}/${PROVIDER.models[0].name}`;

export const PROFILE = {
  assistant_name: ASSISTANT_NAME,
  assistant_identity: 'A calm, practical helper who keeps Sam on top of home, work and family plans.',
  voice_guidance: 'Warm and brief. Lead with the answer, then the details.',
  user_name: OWNER.name,
  address_as: OWNER.firstName,
  user_profile: 'Sam is a project manager in Chicago. Sam lives with their partner Jordan and a dog named Pepper.',
  pinned_preferences: ['Keep answers short.', 'Use 12-hour times.'],
  help_areas: [],
  learning_enabled: true,
};

export const PERSONAS = [
  {
    display_name: 'Zara',
    aliases: ['travel planner'],
    instructions:
      'Help Sam plan trips. Suggest a simple day-by-day plan, keep bookings in one list, and flag anything that still needs booking.',
  },
  {
    display_name: 'Theo',
    aliases: ['budget helper'],
    instructions:
      'Help Sam keep a monthly budget. Sort spending into a few clear groups, point out bills that are due soon, and keep the tone encouraging.',
  },
];

/** Memories saved on different days; `persona` files one under that persona instead of the shared memory. */
export const MEMORIES: readonly { text: string; daysAgo: number; persona?: string }[] = [
  { text: 'Sam is vegetarian and loves Thai food.', daysAgo: 0 },
  { text: "Sam's sister Priya lives in Denver. Her birthday is March 14.", daysAgo: 1 },
  { text: 'Sam prefers meetings before 11 AM.', daysAgo: 3 },
  { text: "Pepper's vet is Lakeview Animal Clinic.", daysAgo: 6 },
  { text: 'Sam and Jordan like quiet hotels within walking distance of the old town.', daysAgo: 2, persona: 'Zara' },
  { text: 'Sam wants to keep eating out under $300 a month.', daysAgo: 4, persona: 'Theo' },
];

export const SPACE_FOLDER = 'Home';

/** `folder: true` files the space in SPACE_FOLDER. */
export const SPACES: readonly { name: string; purpose: string; body: string; folder: boolean }[] = [
  {
    name: 'Kitchen refresh',
    purpose: 'Plan the kitchen paint and new shelves before the spring.',
    folder: true,
    body: [
      '- [x] Pick a paint color (Soft Sage)',
      '- [ ] Get two quotes for open shelves',
      '- [ ] Book a painter for the week of April 7',
    ].join('\n'),
  },
  {
    name: 'Groceries',
    purpose: 'What to buy on the next trip to the store.',
    folder: false,
    body: ['- Chickpeas', '- Baby spinach', '- Jasmine rice', '- Limes', '- Coconut milk'].join('\n'),
  },
  {
    name: 'Lisbon trip budget',
    purpose: 'Keep the costs for the May trip with Jordan in one place.',
    folder: false,
    body: [
      '| Item | Cost | Booked |',
      '| --- | --- | --- |',
      '| Flights | $1,240 | Yes |',
      '| Hotel in Alfama, 7 nights | $1,050 | Yes |',
      '| Day trip to Sintra | $90 | No |',
      '| Anniversary dinner | $160 | No |',
    ].join('\n'),
  },
];

export const CHAT_FOLDER = 'Lisbon trip';

/** The demo inbox and calendar the run's practice mailbox serves, in the server's eval fixture format. */
export const MAILBOX = {
  inbox: {
    mailbox_owner: { name: OWNER.name, email: OWNER.email },
    threads: [
      {
        id: 'thread-dana-lunch',
        subject: 'Lunch this week?',
        messages: [
          {
            from: 'Dana Kim <dana.kim@example.com>',
            to: OWNER.email,
            sent: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
            subject: 'Lunch this week?',
            body: 'Hi Sam,\n\nAre you free for lunch this week? Thursday or Friday works for me.\n\nDana',
          },
        ],
      },
    ],
  },
  calendar: { calendar_owner: OWNER.email, time_zone: TIME_ZONE, events: [] },
};

/** The local date `days` from now in the demo time zone, as YYYY-MM-DD. */
function dayFromNow(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(
    new Date(Date.now() + days * 24 * 60 * 60 * 1000),
  );
}

/** Nine in the morning a week from now in the demo time zone, so a reminder is always in the future. */
function nextWeekAtNine(): string {
  const day = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const offset =
    new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, timeZoneName: 'longOffset' })
      .formatToParts(day)
      .find(part => part.type === 'timeZoneName')
      ?.value.replace('GMT', '') ?? '';
  return `${dayFromNow(7)}T09:00:00${offset === '' ? 'Z' : offset}`;
}

/** The next Friday in the demo time zone, as YYYY-MM-DD. */
function nextFriday(): string {
  for (let days = 1; days <= 7; days += 1) {
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'long' }).format(
      new Date(Date.now() + days * 24 * 60 * 60 * 1000),
    );
    if (weekday === 'Friday') return dayFromNow(days);
  }
  return dayFromNow(7);
}

/** The id the draft tool answered with, so the next call can send that draft. */
const BRIEF = {
  digest: 'A light day: one reply to send, the vet to book, and the Lisbon hotel deposit due Friday.',
  items: [
    {
      section: 'check_first',
      title: 'Dentist on two days',
      subtitle: ['Calendar has Tuesday 3 PM', 'The reminder email says Wednesday'],
      source: 'calendar',
      action: {
        label: 'Ask the office',
        target: { kind: 'prompt', text: 'Draft a note asking the dentist which day is right.' },
      },
    },
    {
      section: 'decision',
      title: 'Reply to Dana about lunch',
      subtitle: ['Dana Kim', 'Thursday or Friday'],
      source: 'email',
      action: { label: 'Draft a reply', target: { kind: 'prompt', text: 'Reply to Dana and say Thursday works' } },
    },
    {
      section: 'coming_up',
      title: 'Team planning call',
      subtitle: ['Video call', '45 minutes'],
      source: 'calendar',
      when: `${dayFromNow(0)}T10:00:00-06:00`,
      action: {
        label: 'Prepare notes',
        target: { kind: 'prompt', text: 'Help me prepare for the team planning call.' },
      },
    },
    {
      section: 'deadline',
      title: 'Lisbon hotel deposit',
      subtitle: ['$300', 'Due Friday'],
      source: 'space',
      action: { label: 'Open the budget', target: { kind: 'prompt', text: 'Show my Lisbon trip budget.' } },
    },
  ],
};

/** One demo chat: its title, and the text that shows once Aman has answered when that is not the reply's first line. */
export type DemoChat = DemoExchange & { title: string; shows?: string };

/** What Sam asks in each chat the run makes. */
export const CHATS = {
  dinner: {
    title: 'Dinner with chickpeas and spinach',
    ask: 'What can I make tonight with chickpeas, spinach and rice?',
    reply: [
      'Try a quick chickpea and spinach curry over rice. It takes about 25 minutes.',
      '',
      '1. Cook 1 cup of rice.',
      '2. Soften an onion, 2 cloves of garlic and a spoon of curry paste in a little oil.',
      '3. Add the chickpeas and a can of coconut milk, and simmer for 10 minutes.',
      '4. Stir in the spinach until it wilts, then add lime juice and salt.',
      '',
      'Want a shopping list for anything you are missing?',
    ].join('\n'),
  },
  lisbon: {
    title: 'A free day in Lisbon',
    ask: 'We have one free day in Lisbon. What should we do?',
    reply: [
      'Here is an easy day that keeps the walking gentle:',
      '',
      '- **Morning:** ride Tram 28 up to Alfama and walk to the Santa Luzia viewpoint.',
      '- **Lunch:** a veggie plate near the cathedral.',
      '- **Afternoon:** Belém for the monastery and a custard tart.',
      '- **Evening:** sunset at the LX Factory, then dinner in Bairro Alto.',
    ].join('\n'),
  },
  sintra: {
    title: 'Getting to Sintra',
    ask: 'How do we get from Lisbon to Sintra?',
    reply:
      'Take the train from Rossio station. Trains leave about every 20 minutes and the ride takes 40 minutes. Go early: the palaces get busy by 11.',
  },
  brief: {
    title: 'Morning brief on weekdays',
    ask: 'Send me a morning brief at 7:30 every weekday',
    reply: 'Done. Your morning brief will arrive at 7:30 AM every weekday, starting tomorrow.',
    tools: [
      {
        match: 'create_schedule',
        arguments: {
          name: 'morning-brief',
          morning_brief: true,
          repeat: 'weekdays',
          time: '07:30',
          time_zone: TIME_ZONE,
        },
      },
    ],
  },
  bills: {
    title: 'Friday bills check',
    ask: 'Every Friday at 5 PM, check which bills are due next week',
    reply: 'All set. Every Friday at 5:00 PM I will list the bills due the following week.',
    tools: [
      {
        match: 'create_schedule',
        arguments: {
          name: 'friday-bills-check',
          task: 'List the bills that are due next week, with the amount and the day each is due.',
          repeat: 'weekly',
          days: ['friday'],
          time: '17:00',
          time_zone: TIME_ZONE,
        },
      },
    ],
  },
  plants: {
    title: 'Water the plants',
    ask: 'Every Sunday at 10 AM, remind me what the plants need',
    reply: 'Done. Every Sunday at 10:00 AM I will tell you which plants need water or food.',
    tools: [
      {
        match: 'create_schedule',
        arguments: {
          name: 'sunday-plant-care',
          task: 'Tell me which houseplants need water or plant food this week.',
          repeat: 'weekly',
          days: ['sunday'],
          time: '10:00',
          time_zone: TIME_ZONE,
        },
      },
    ],
  },
  morningBrief: {
    title: 'Morning brief',
    ask: MORNING_BRIEF_PROMPT,
    shows: 'Needs a decision',
    reply: ['Good morning, Sam.', '', '```json', JSON.stringify(BRIEF, null, 2), '```'].join('\n'),
  },
  calendarEvent: {
    title: 'Lunch with Dana',
    ask: 'Add lunch with Dana on Friday at 12:30 for an hour',
    reply: 'Lunch with Dana is on your calendar for Friday at 12:30 PM.',
    tools: [
      {
        match: 'create_event',
        arguments: {
          title: 'Lunch with Dana',
          start: `${nextFriday()}T12:30`,
          end: `${nextFriday()}T13:30`,
          time_zone: TIME_ZONE,
          location: 'Little Goat Diner, 820 W Randolph St, Chicago',
          attendees: ['dana.kim@example.com'],
          send_updates: 'all',
        },
      },
    ],
  },
  deletePlants: {
    title: 'Stop the plant care check',
    ask: 'Delete my Sunday plant care schedule',
    reply: 'Done. The Sunday plant care check is deleted.',
    tools: [{ match: 'delete_schedule', arguments: { schedule: 'sunday-plant-care' } }],
  },
  help: {
    title: 'Help',
    ask: 'Iris, I am stuck and need help.',
    reply: 'Where are you stuck? Pick one of the choices below, or tell me in your own words.',
  },
  reminder: {
    title: 'Reminder to book the vet',
    ask: "Remind me next week to book Pepper's checkup",
    reply: "I'll remind you next week at 9:00 AM to book Pepper's checkup.",
    tools: [{ match: 'set_reminder', arguments: { what: "Book Pepper's checkup", at: nextWeekAtNine() } }],
  },
  keepBills: {
    title: 'Keep the bills check',
    ask: 'Delete my Friday bills check',
    reply: 'Okay, I kept your Friday bills check.',
    tools: [{ match: 'delete_schedule', arguments: { schedule: 'friday-bills-check' } }],
  },
  incognito: {
    title: 'Birthday gift',
    ask: 'What should I get Priya for her birthday?',
    reply:
      'Since Priya loves hiking, a good pick is a light daypack or a national parks pass. If you want something smaller, a trail guide for the Colorado Rockies with a handwritten note is a warm choice.',
  },
} satisfies Record<string, DemoChat>;

export type ChatKey = keyof typeof CHATS;

/** Chats the run makes before any shot, oldest first, with how many days ago each happened. */
/** `decline` answers the chat's card with Not now, so the activity log shows a denied request. */
export const SEEDED_CHATS: readonly { key: ChatKey; daysAgo: number; folder?: boolean; decline?: boolean }[] = [
  { key: 'sintra', daysAgo: 9, folder: true },
  { key: 'lisbon', daysAgo: 8, folder: true },
  { key: 'plants', daysAgo: 6 },
  { key: 'bills', daysAgo: 4 },
  { key: 'brief', daysAgo: 3 },
  { key: 'reminder', daysAgo: 2 },
  { key: 'keepBills', daysAgo: 1, decline: true },
  { key: 'dinner', daysAgo: 0 },
  { key: 'morningBrief', daysAgo: 0 },
];

/** A schedule shown as paused on the Schedules page. */
export const PAUSED_SCHEDULE = 'sunday-plant-care';

/** Schedules run once while the world is set up, so their runs show on the Schedules page. */
export const RUN_SCHEDULES: readonly string[] = ['morning-brief', 'friday-bills-check'];

/** A reminder that has already come due, so the bell has something to show. */
export const DUE_REMINDER = { text: 'Call the pharmacy', minutesAgo: 20 };

/** Chats that use Sam's email or calendar, which the run's practice mailbox stands in for. */
export const MAILBOX_CHATS: readonly ChatKey[] = ['calendarEvent'];

export const EXCHANGES: readonly DemoExchange[] = Object.values(CHATS);
