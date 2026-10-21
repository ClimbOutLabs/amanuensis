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

export type TourPrompt = {
  key: string;
  label: string;
  prompt: string;
  /** Capabilities that unlock the prompt; it shows when any one of them is present. Absent when it works on any instance. */
  needs?: readonly (keyof TourCapabilities)[];
};

/** The prompts whose capability this instance has; the rest are left out, not greyed out. */
export function visibleTourPrompts(prompts: readonly TourPrompt[], capabilities: TourCapabilities): TourPrompt[] {
  return prompts.filter(item => item.needs === undefined || item.needs.some(name => capabilities[name]));
}

/** How many cards follow the morning brief in the Try a day list. */
const DAY_CARD_SLOTS = 5;

const MORNING_BRIEF: TourPrompt = {
  key: 'brief',
  label: 'Your morning brief',
  prompt: 'Good morning! Give me my brief for today.',
};

const PLAN_DAY: TourPrompt = {
  key: 'plan-day',
  label: 'Help me plan my day',
  prompt: "Plan my day around what's on my list, with lunch somewhere nearby.",
};

const DOCTOR_APPOINTMENT: TourPrompt = {
  key: 'doctor-appointment',
  label: "Help me with doctor's appointments",
  prompt: 'Help me get ready for my next appointment.',
  needs: ['calendar'],
};

const FORGOTTEN_SUBSCRIPTIONS: TourPrompt = {
  key: 'subscriptions',
  label: 'Find forgotten subscriptions',
  prompt: 'Look through my email for subscriptions I may have forgotten, and tell me what each one costs a month.',
  needs: ['email'],
};

/** The general set: what every person sees when no area is chosen. */
export const GENERAL_DAY_PROMPTS: readonly TourPrompt[] = [
  {
    key: 'scam-check',
    label: 'Check for scams',
    prompt: 'Is anything in my inbox a scam?',
    needs: ['email'],
  },
  {
    key: 'reply',
    label: 'Reply to an email',
    prompt: 'Help me reply to my most recent email that needs an answer.',
    needs: ['email'],
  },
  PLAN_DAY,
  DOCTOR_APPOINTMENT,
  FORGOTTEN_SUBSCRIPTIONS,
];

/** The cards each help area offers, in the order they are tried. */
export const HELP_AREAS: Record<HelpAreaId, { label: string; cards: readonly TourPrompt[] }> = {
  focus: {
    label: 'Focus and getting started',
    cards: [
      {
        key: 'clear-head',
        label: 'Help me clear my head',
        prompt:
          "I have too much going on. Ask me what's on my mind, then sort it into today, this week, and later, and keep that list for me.",
      },
      {
        key: 'break-task',
        label: 'Help me break a task into steps',
        prompt:
          'Help me break a task into steps. Ask me what the task is, then split it into small steps I can each do in about 10 minutes, and keep the list so we can tick them off together.',
      },
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
      {
        key: 'meals',
        label: "Plan this week's meals",
        prompt: "Plan this week's meals around what we already have, and make the shopping list.",
      },
      DOCTOR_APPOINTMENT,
      {
        key: 'owe-reply',
        label: 'Who do I owe a reply?',
        prompt: 'Who do I owe a reply, a thank-you, or a gift? Check my email and calendar.',
        needs: ['email'],
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
      DOCTOR_APPOINTMENT,
      {
        key: 'care-visit',
        label: 'Prepare for a care visit',
        prompt:
          "I have a doctor's visit coming up for someone I care for. Help me write down what to tell the doctor and what to ask.",
      },
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
    ],
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
    ],
  },
};

/** The "What Aman can do" list: one card per capability, each a tap away from a chat. */
export const CAPABILITY_PROMPTS: readonly TourPrompt[] = [
  {
    key: 'email',
    label: 'Handle your email',
    prompt: 'Go through my unread email and tell me what needs a reply first.',
    needs: ['email'],
  },
  { key: 'schedule', label: 'Run things on a schedule', prompt: 'Set up a routine that checks my bills every Friday.' },
  {
    key: 'calendar',
    label: 'Keep your calendar',
    prompt: 'What is on my calendar this week?',
    needs: ['calendar'],
  },
  {
    key: 'places',
    label: 'Find places and plan routes',
    prompt: 'Find a quiet coffee shop near me and plan the walk there.',
  },
  {
    key: 'web',
    label: 'Research the live web',
    prompt: 'Look up the latest news on a topic I care about and sum it up for me.',
  },
  {
    key: 'documents',
    label: 'Keep living documents',
    prompt: 'Start a living document for my packing list that I can update later.',
  },
  {
    key: 'specialists',
    label: 'Bring in specialists',
    prompt: 'Bring in a specialist to help me plan my next trip.',
  },
  {
    key: 'code',
    label: 'Read files and run code',
    prompt: 'Add up these expenses and show me the total: 12.50, 8, 31.20.',
    needs: ['sandbox'],
  },
  { key: 'memory', label: 'Remember what matters', prompt: 'What do you remember about me so far?' },
  {
    key: 'skills',
    label: 'Learn new skills',
    prompt: 'Learn a new skill that turns my receipts into a monthly expense list.',
    needs: ['sandbox'],
  },
  {
    key: 'move',
    label: 'Move with you',
    prompt: 'What can you do for me when I am away from my desk?',
  },
  { key: 'cost', label: 'Show what it costs', prompt: 'Show me what my chats have cost so far this month.' },
];

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
 * The Try a day cards: the morning brief first, then five more from the chosen areas. Areas share
 * the five evenly in the order chosen, and any shortfall, including a missing capability, is filled
 * from the general set. With no area chosen, the general set alone.
 */
export function tryADayPrompts({
  helpAreas,
  capabilities,
}: {
  helpAreas: readonly HelpAreaId[];
  capabilities: TourCapabilities;
}): TourPrompt[] {
  const areaQueues = helpAreas.map(id => visibleTourPrompts(HELP_AREAS[id].cards, capabilities));
  const general = visibleTourPrompts(GENERAL_DAY_PROMPTS, capabilities);
  const fiveCards = uniqueByKey([...interleave(areaQueues), ...general]).slice(0, DAY_CARD_SLOTS);
  return [MORNING_BRIEF, ...fiveCards];
}
