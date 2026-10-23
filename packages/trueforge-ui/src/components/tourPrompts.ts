import { MORNING_BRIEF_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { type HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

/** What this instance can do, so the tour only offers prompts that will work here. */
export type TourCapabilities = {
  /** Gmail read is granted. */
  email: boolean;
  /** Calendar read is granted. */
  calendar: boolean;
  /** A sandbox is configured, so Aman can run code and skills. */
  sandbox: boolean;
  /** The maps tools are available for place search and routes. */
  maps: boolean;
};

/** The pictures a capability ticket can carry; a prompt without one shows as a plain ticket. */
export const TOUR_ILLUSTRATION_KEYS = [
  'email',
  'subscriptions',
  'reply',
  'schedule',
  'calendar',
  'places',
  'web',
  'spaces',
  'specialists',
  'code',
  'memory',
  'skills',
] as const;

export type TourIllustrationKey = (typeof TOUR_ILLUSTRATION_KEYS)[number];

export type TourPrompt = {
  key: string;
  label: string;
  prompt: string;
  /** Capabilities that unlock the prompt; it shows when any one of them is present. Absent when it works on any instance. */
  needs?: readonly (keyof TourCapabilities)[];
  illustration?: TourIllustrationKey;
};

/** The prompts whose capability this instance has; the rest are left out, not greyed out. */
export function visibleTourPrompts(prompts: readonly TourPrompt[], capabilities: TourCapabilities): TourPrompt[] {
  return prompts.filter(item => item.needs === undefined || item.needs.some(name => capabilities[name]));
}

/** How many capability tickets the first frame shows: a full row of four on a desktop. */
export const FIRST_FRAME_CARD_SLOTS = 4;

/** The capability ticket that always shows on the first frame, so the person can always reach their pages. */
export const KEEP_PAGES_IN_SPACES: TourPrompt = {
  key: 'spaces',
  label: 'Keep pages in Spaces',
  prompt:
    'Make a space called Dog breeds. It\'s a page I can come back to while I pick a dog. For each breed show: size, energy level, grooming, how it does with kids and other pets, apartment-friendly or not, common health issues, and typical lifespan. Start with 8 popular family breeds as cards I can compare at a glance. Add a "My shortlist" section at the top that stays empty until I tell you which ones I like. Keep it up to date as we talk. Then tell me where to find it.',
  illustration: 'spaces',
};

/** The brief: the first card of the Productivity pill. It needs no capability, so it always shows. */
export const MORNING_BRIEF: TourPrompt = {
  key: 'brief',
  label: 'Open the brief',
  prompt: MORNING_BRIEF_PROMPT,
};

const CLEAR_HEAD: TourPrompt = {
  key: 'clear-head',
  label: 'Help me clear my head',
  prompt:
    "I have too much going on. Ask me what's on my mind, then sort it into today, this week, and later, and keep that list for me.",
};

const BREAK_TASK: TourPrompt = {
  key: 'break-task',
  label: 'Help me break a task into steps',
  prompt:
    'Help me break a task into steps. Ask me what the task is, then split it into small steps I can each do in about 10 minutes, and keep the list so we can tick them off together.',
};

const PLAN_DAY: TourPrompt = {
  key: 'plan-day',
  label: 'Help me plan my day',
  prompt:
    "Help me plan my day. Look at my calendar and my to-do list, put things in a sensible order with times, and find a good place for lunch near where I'll be.",
};

const APPOINTMENT: TourPrompt = {
  key: 'appointment',
  label: "Help me with doctor's appointments",
  prompt:
    "Help me with my doctor's appointments. Find any coming up in my calendar and email, tell me what to bring and what to ask, and remind me of anything I still need to book.",
  needs: ['calendar', 'email'],
};

const MEALS: TourPrompt = {
  key: 'meals',
  label: "Plan this week's meals",
  prompt: "Plan this week's meals around what we already have, and make the shopping list.",
};

const SELF_CARE: TourPrompt = {
  key: 'self-care',
  label: 'Help me practice self-care',
  prompt:
    "I'd like to practice self-care today. Before you suggest anything, ask me three short questions, one at a time: how I'm feeling right now, how much time and energy I have today, and what usually helps me feel better. Then give me a few small, doable ideas for today.",
};

const FORGOTTEN_SUBSCRIPTIONS: TourPrompt = {
  key: 'subscriptions',
  label: 'Find forgotten subscriptions',
  prompt:
    "Look through my email for subscriptions and renewals. List what I'm paying for, how much and how often, and flag anything I may have forgotten about.",
  needs: ['email'],
  illustration: 'subscriptions',
};

/** The Productivity pill's starter: what the assistant has noticed, asked in plain words. */
export const WATCHING_PROMPT: TourPrompt = {
  key: 'watching',
  label: 'What have you noticed?',
  prompt: 'What have you noticed for me lately that I should know about? Keep it short.',
};

/** The Productivity pill's starter: the answer the person owes right now. */
export const WAITING_PROMPT: TourPrompt = {
  key: 'waiting',
  label: 'What is waiting for me?',
  prompt:
    'What is waiting for my answer right now? List each thing, and tell me which one matters most so I can start there.',
};

/** The cards each help area offers, in the order they are tried. */
export const HELP_AREAS: Record<HelpAreaId, { label: string; cards: readonly TourPrompt[] }> = {
  focus: {
    label: 'Focus and getting started',
    cards: [
      CLEAR_HEAD,
      BREAK_TASK,
      {
        key: 'get-started',
        label: 'Help me get started',
        prompt:
          "I can't get started. Pick the one smallest thing I should do right now, and check in with me in 25 minutes.",
      },
      {
        key: 'forgot',
        label: 'What did I forget?',
        prompt: 'Look at my email and calendar for anything I promised, owe, or need to reply to.',
        needs: ['email', 'calendar'],
      },
      {
        key: 'calm-day',
        label: 'Plan a calm day',
        prompt:
          'Help me plan a calm day. Ask what I have to do, then give me a short plan with breaks and only three must-dos.',
      },
      {
        key: 'routine',
        label: "Build a routine I'll keep",
        prompt: 'Help me build a simple morning routine I can actually stick to, then remind me each morning at 8.',
      },
    ],
  },
  family: {
    label: 'Family and home',
    cards: [
      {
        key: 'family-week',
        label: 'This week for my family',
        prompt:
          "What's coming up for my family this week? School, appointments, birthdays and bills. Put it in one list.",
        needs: ['calendar', 'email'],
      },
      MEALS,
      APPOINTMENT,
      {
        key: 'owe-reply',
        label: 'Who do I owe a reply?',
        prompt: 'Who do I owe a reply, a thank-you, or a gift? Check my email and calendar.',
        needs: ['email'],
      },
      {
        key: 'chores',
        label: 'Split the chores fairly',
        prompt:
          'Help me split the household chores fairly. Ask me who lives here and what needs doing, then make a weekly chart.',
      },
      {
        key: 'birthday',
        label: 'Plan a birthday',
        prompt:
          "Help me plan a birthday party. Ask me who it's for, the budget and the date, then make a to-do list and a timeline.",
      },
    ],
  },
  caring: {
    label: 'Caring for someone',
    cards: [
      {
        key: 'care-track',
        label: "Keep track of someone's care",
        prompt:
          "Help me keep track of someone's care: their medicines, appointments and questions for their doctor. Ask me who it is, then keep it all in one place.",
      },
      {
        key: 'care-visit',
        label: 'Prepare for a care visit',
        prompt:
          "I have a doctor's visit coming up for someone I care for. Help me write down what to tell the doctor and what to ask.",
      },
      APPOINTMENT,
      {
        key: 'medicine',
        label: 'Make a medicine schedule',
        prompt:
          'Make a simple daily medicine schedule for someone I care for. Ask me the medicines and times, and remind me when each one is due.',
      },
      {
        key: 'family-update',
        label: 'Write a family update',
        prompt: 'Help me write a short, clear update for the family about how someone I care for is doing.',
      },
      SELF_CARE,
    ],
  },
  new_country: {
    label: 'New to a country',
    cards: [
      {
        key: 'settle',
        label: 'What do I need to sort out?',
        prompt:
          "I'm new to this country. What do I need to sort out this month: visa, bank, health care and housing? Ask me where I live now, then make me a checklist.",
      },
      {
        key: 'letter',
        label: 'Explain a letter',
        prompt:
          "I got a letter in a language I don't read well. Help me understand it and tell me if I need to do anything.",
      },
      {
        key: 'family-doctor',
        label: 'Find a doctor near me',
        prompt: 'Help me find a family doctor near where I live, and tell me how to register.',
        needs: ['maps'],
      },
      {
        key: 'newcomers',
        label: 'What newcomers get wrong',
        prompt: 'What do newcomers here often get wrong in everyday life? Ask me where I live first.',
      },
      {
        key: 'language',
        label: 'Practice the language',
        prompt:
          'Help me practice the local language for ten minutes. Ask me what I need it for, like the doctor or the bakery.',
      },
      {
        key: 'neighborhood',
        label: 'Choose a neighborhood',
        prompt:
          'Help me choose a neighborhood to live in. Ask me what matters to me, then compare a few options on rent, commute and feel.',
      },
    ],
  },
  productivity: {
    label: 'Productivity',
    cards: [MORNING_BRIEF, WAITING_PROMPT, WATCHING_PROMPT, PLAN_DAY],
  },
  work_money: {
    label: 'Work and money',
    cards: [
      FORGOTTEN_SUBSCRIPTIONS,
      {
        key: 'invoices',
        label: 'Chase unpaid invoices',
        prompt: 'Which of my invoices are unpaid, and who should I chase? Check my email.',
        needs: ['email'],
      },
      PLAN_DAY,
      {
        key: 'budget',
        label: 'Make a simple budget',
        prompt: 'Help me make a simple monthly budget. Ask me what comes in and what goes out, and show it as a chart.',
      },
      {
        key: 'meeting',
        label: 'Get ready for a meeting',
        prompt: 'Help me get ready for my next meeting: who is in it, what it is about, and three things I should say.',
        needs: ['calendar'],
      },
      {
        key: 'tricky-email',
        label: 'Write a tricky email',
        prompt:
          'Help me write a polite but firm email about something that is bothering me at work. Ask me what happened first.',
      },
    ],
  },
};

/** The "What Aman can do" list: one card per capability, each a tap away from a chat. */
export function capabilityPrompts(assistantName: string): readonly TourPrompt[] {
  return [
    {
      // Naming the guide invokes it, so the reply comes from Iris, the guide persona.
      key: 'get-to-know',
      label: `Get to know ${assistantName}`,
      prompt: 'Iris, introduce yourself and show me how to get started.',
    },
    {
      key: 'email',
      label: 'Handle your email',
      prompt: 'Go through my unread email and tell me what needs a reply first.',
      needs: ['email'],
      illustration: 'email',
    },
    FORGOTTEN_SUBSCRIPTIONS,
    {
      key: 'reply',
      label: 'Reply to an email',
      prompt: 'Help me reply to my most recent email that needs an answer.',
      needs: ['email'],
      illustration: 'reply',
    },
    {
      key: 'schedule',
      label: 'Run things on a schedule',
      prompt: 'Every weekday at 7:30, send me my morning brief.',
      illustration: 'schedule',
    },
    {
      key: 'calendar',
      label: 'Keep your calendar',
      prompt: 'What is on my calendar this week?',
      needs: ['calendar'],
      illustration: 'calendar',
    },
    {
      key: 'places',
      label: 'Find places and plan routes',
      prompt: 'Find a quiet coffee shop near me and plan the walk there.',
      illustration: 'places',
    },
    {
      key: 'web',
      label: 'Research the live web',
      prompt: "What's in the news today? Give me the five stories that matter, two lines each.",
      illustration: 'web',
    },
    KEEP_PAGES_IN_SPACES,
    {
      key: 'specialists',
      label: 'Bring in specialists',
      prompt: "Get a travel specialist to plan a long weekend somewhere I've never been.",
      illustration: 'specialists',
    },
    {
      key: 'code',
      label: 'Read files and run code',
      prompt: 'Add up my expenses by category and make a chart: rent 900, groceries 210, transport 45, eating out 80.',
      needs: ['sandbox'],
      illustration: 'code',
    },
    {
      key: 'memory',
      label: 'Remember what matters',
      prompt: 'What do you remember about me so far?',
      illustration: 'memory',
    },
    {
      key: 'skills',
      label: 'Learn new skills',
      prompt: 'Learn how to turn a photo of a receipt into a line in my expense list.',
      needs: ['sandbox'],
      illustration: 'skills',
    },
    {
      key: 'move',
      label: 'Move with you',
      prompt: 'How do I use you from my phone?',
    },
    { key: 'cost', label: 'Show what it costs', prompt: 'Show me what my chats have cost so far this month.' },
  ];
}

/** Keeps the first card for each key, so a card that two areas offer appears once. */
function uniqueByKey(prompts: readonly TourPrompt[]): TourPrompt[] {
  const seen = new Set<string>();
  return prompts.filter(item => {
    if (seen.has(item.key)) {
      return false;
    }
    seen.add(item.key);
    return true;
  });
}

/** Takes one card from each queue in turn, so the chosen areas share the cards evenly and in the order chosen. */
function interleave(queues: readonly (readonly TourPrompt[])[]): TourPrompt[] {
  const longest = Math.max(0, ...queues.map(queue => queue.length));
  const picked: TourPrompt[] = [];
  for (let position = 0; position < longest; position += 1) {
    for (const queue of queues) {
      const item = queue[position];
      if (item !== undefined) {
        picked.push(item);
      }
    }
  }
  return picked;
}

/**
 * The first frame's capability tickets: the cards of the areas the person chose come first, in the
 * order chosen, so the chooser shapes what is offered. Keep pages in Spaces always keeps its place;
 * the other slots fill from the areas and then the capability list.
 */
export function firstFrameCardPrompts({
  helpAreas,
  capabilities,
  assistantName,
}: {
  helpAreas: readonly HelpAreaId[];
  capabilities: TourCapabilities;
  assistantName: string;
}): TourPrompt[] {
  const areaQueues = helpAreas.map(id => visibleTourPrompts(HELP_AREAS[id].cards, capabilities));
  const others = uniqueByKey([
    ...interleave(areaQueues),
    ...visibleTourPrompts(capabilityPrompts(assistantName), capabilities),
  ]).filter(item => item.key !== KEEP_PAGES_IN_SPACES.key);
  return [...others.slice(0, FIRST_FRAME_CARD_SLOTS - 1), KEEP_PAGES_IN_SPACES];
}

/** The most starter suggestions the home offers under the composer. */
const STARTER_SLOTS = 3;

/**
 * Up to three starters from the areas the person picked, in the order picked. None until an area
 * is picked, so the home stays quiet for a person who has not chosen one.
 */
export function starterPrompts({
  helpAreas,
  capabilities,
}: {
  helpAreas: readonly HelpAreaId[];
  capabilities: TourCapabilities;
}): TourPrompt[] {
  const areaQueues = helpAreas.map(id => visibleTourPrompts(HELP_AREAS[id].cards, capabilities));
  return uniqueByKey(interleave(areaQueues)).slice(0, STARTER_SLOTS);
}
