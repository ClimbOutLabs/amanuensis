import { MORNING_BRIEF_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { HELP_AREA_IDS } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

/** What this instance can do, so the home only offers examples that will work here. */
export type TourCapabilities = {
  /** Gmail read is granted. */
  email: boolean;
  /** Calendar read is granted. */
  calendar: boolean;
  /** A sandbox is configured, so the assistant can run code and skills. */
  sandbox: boolean;
  /** The maps tools are available for place search and routes. */
  maps: boolean;
};

/** One example card on the home: pressing it puts `prompt` in the composer, and nothing sends until the person does. */
export type TourPrompt = {
  key: string;
  title: string;
  /** One short line under the title, naming the assistant by its display name. */
  detail: (assistant: string) => string;
  prompt: string;
  icon: string;
  /** Capabilities that unlock the example; it shows when any one of them is present. Absent when it works on any instance. */
  needs?: readonly (keyof TourCapabilities)[];
};

/** How many cards the home shows at once. */
export const HOME_CARD_COUNT = 4;

/** The examples whose capability this instance has; the rest are left out, not greyed out. */
export function visibleTourPrompts(prompts: readonly TourPrompt[], capabilities: TourCapabilities): TourPrompt[] {
  return prompts.filter(item => item.needs === undefined || item.needs.some(name => capabilities[name]));
}

/** The cards shown when no topic pill is chosen. */
export const GENERAL_CARDS: readonly TourPrompt[] = [
  {
    key: 'reply',
    title: 'Draft a reply',
    detail: () => 'Reads the thread, writes it, asks before sending',
    prompt:
      'Help me draft a reply to my most recent email that needs one. Read the whole thread first, and ask me before you send anything.',
    icon: 'square-pen',
  },
  {
    key: 'plan',
    title: 'Plan your day',
    detail: () => 'Finds conflicts and travel time on your calendar',
    prompt: 'Help me plan my day. Check my calendar for conflicts and travel time, then suggest an order for my tasks.',
    icon: 'calendar-clock',
  },
  {
    key: 'places',
    title: 'Find places and routes',
    detail: () => 'A map with the stops, and how long it takes',
    prompt: 'Help me find places I need to go today. Show the stops on a map, and how long each route takes.',
    icon: 'map-pin',
  },
  {
    key: 'schedule',
    title: 'Run things on a schedule',
    detail: () => 'A brief every morning, a check every Friday',
    prompt:
      'Help me set something up to run on a schedule: a brief every morning, and a check every Friday. Ask me what to look at first.',
    icon: 'clock',
  },
];

const CLEAR_HEAD: TourPrompt = {
  key: 'clear-head',
  title: 'Clear my head',
  detail: assistant => `${assistant} asks what is on your mind and sorts it into today, this week and later`,
  prompt:
    "I have too much going on. Ask me what's on my mind, then sort it into today, this week, and later, and keep that list for me.",
  icon: 'lightbulb',
};

const BREAK_TASK: TourPrompt = {
  key: 'break-task',
  title: 'Break a task into steps',
  detail: () => 'Small steps of about ten minutes each, kept as a list',
  prompt:
    'Help me break a task into steps. Ask me what the task is, then split it into small steps I can each do in about 10 minutes, and keep the list so we can tick them off together.',
  icon: 'list-check',
};

const PLAN_DAY: TourPrompt = {
  key: 'plan-day',
  title: 'Plan my day',
  detail: assistant => `${assistant} puts your calendar and to-dos in order, with times`,
  prompt:
    "Help me plan my day. Look at my calendar and my to-do list, put things in a sensible order with times, and find a good place for lunch near where I'll be.",
  icon: 'calendar-clock',
};

const APPOINTMENT: TourPrompt = {
  key: 'appointment',
  title: "Doctor's appointments",
  detail: () => 'What is coming up, what to bring and what to ask',
  prompt:
    "Help me with my doctor's appointments. Find any coming up in my calendar and email, tell me what to bring and what to ask, and remind me of anything I still need to book.",
  icon: 'calendar',
  needs: ['calendar', 'email'],
};

/** The topic pills, in the order the home shows them. Productivity comes first, then the help areas. */
export const HOME_TOPIC_IDS = ['productivity', ...HELP_AREA_IDS] as const;

export type HomeTopicId = (typeof HOME_TOPIC_IDS)[number];

export function isHomeTopicId(value: string): value is HomeTopicId {
  return HOME_TOPIC_IDS.some(id => id === value);
}

/** The cards each topic offers, in the order they are tried; capability gaps fall through to the next. */
export const HOME_TOPICS: Record<HomeTopicId, { label: string; cards: readonly TourPrompt[] }> = {
  productivity: {
    label: 'Productivity',
    cards: [
      {
        key: 'brief',
        title: 'Your morning brief',
        detail: assistant => `${assistant} gathers your mail, calendar and to-dos into one note each morning`,
        prompt: MORNING_BRIEF_PROMPT,
        icon: 'book-open',
      },
      CLEAR_HEAD,
      BREAK_TASK,
      PLAN_DAY,
    ],
  },
  focus: {
    label: 'Focus and getting started',
    cards: [
      CLEAR_HEAD,
      {
        key: 'get-started',
        title: 'Help me get started',
        detail: () => 'One small thing you can finish in 25 minutes',
        prompt:
          "I can't get started. Pick the one smallest thing I should do right now, small enough to finish in 25 minutes.",
        icon: 'play',
      },
      {
        key: 'forgot',
        title: 'What did I forget?',
        detail: () => 'Promises, replies and things you owe, from your mail and calendar',
        prompt: 'Look at my email and calendar for anything I promised, owe, or need to reply to.',
        icon: 'circle-check',
        needs: ['email', 'calendar'],
      },
      {
        key: 'calm-day',
        title: 'Plan a calm day',
        detail: () => 'A short plan with breaks and only three must-dos',
        prompt:
          'Help me plan a calm day. Ask what I have to do, then give me a short plan with breaks and only three must-dos.',
        icon: 'sun',
      },
      {
        key: 'routine',
        title: "Build a routine I'll keep",
        detail: assistant => `A simple morning routine, and ${assistant} reminds you each day`,
        prompt: 'Help me build a simple morning routine I can actually stick to, then remind me each morning at 8.',
        icon: 'clock',
      },
      BREAK_TASK,
    ],
  },
  family: {
    label: 'Family and home',
    cards: [
      {
        key: 'family-week',
        title: 'This week for my family',
        detail: () => 'School, appointments, birthdays and bills in one list',
        prompt:
          "What's coming up for my family this week? School, appointments, birthdays and bills. Put it in one list.",
        icon: 'calendar',
        needs: ['calendar', 'email'],
      },
      {
        key: 'meals',
        title: "Plan this week's meals",
        detail: () => 'Meals around what you have, and the shopping list',
        prompt: "Plan this week's meals around what we already have, and make the shopping list.",
        icon: 'list-check',
      },
      {
        key: 'chores',
        title: 'Split the chores fairly',
        detail: assistant => `${assistant} asks who lives with you and makes a weekly chart`,
        prompt:
          'Help me split the household chores fairly. Ask me who lives here and what needs doing, then make a weekly chart.',
        icon: 'broom',
      },
      {
        key: 'birthday',
        title: 'Plan a birthday',
        detail: () => 'A to-do list and a timeline for the day',
        prompt:
          "Help me plan a birthday party. Ask me who it's for, the budget and the date, then make a to-do list and a timeline.",
        icon: 'calendar-plus',
      },
      {
        key: 'outing',
        title: 'Plan a weekend outing',
        detail: () => 'Somewhere nearby everyone will enjoy, with the route',
        prompt:
          'Help me plan a weekend outing for my family. Ask me who is coming and what they like, then suggest a few places nearby with how to get there.',
        icon: 'map-pin',
      },
    ],
  },
  caring: {
    label: 'Caring for someone',
    cards: [
      {
        key: 'care-track',
        title: "Keep track of someone's care",
        detail: assistant => `Medicines, appointments and questions, kept in one place by ${assistant}`,
        prompt:
          "Help me keep track of someone's care: their medicines, appointments and questions for their doctor. Ask me who it is, then keep it all in one place.",
        icon: 'list-check',
      },
      {
        key: 'care-visit',
        title: 'Prepare for a care visit',
        detail: () => 'What to tell the doctor, and what to ask',
        prompt:
          "I have a doctor's visit coming up for someone I care for. Help me write down what to tell the doctor and what to ask.",
        icon: 'square-pen',
      },
      APPOINTMENT,
      {
        key: 'medicine',
        title: 'Make a medicine schedule',
        detail: assistant => `A daily schedule, and ${assistant} reminds you when each one is due`,
        prompt:
          'Make a simple daily medicine schedule for someone I care for. Ask me the medicines and times, and remind me when each one is due.',
        icon: 'clock',
      },
      {
        key: 'family-update',
        title: 'Write a family update',
        detail: () => 'A short, clear note on how they are doing',
        prompt: 'Help me write a short, clear update for the family about how someone I care for is doing.',
        icon: 'message-square-text',
      },
      {
        key: 'self-care',
        title: 'Take care of yourself too',
        detail: assistant => `${assistant} asks three short questions, then suggests small ideas for today`,
        prompt:
          "I'd like to practice self-care today. Before you suggest anything, ask me three short questions, one at a time: how I'm feeling right now, how much time and energy I have today, and what usually helps me feel better. Then give me a few small, doable ideas for today.",
        icon: 'sun',
      },
    ],
  },
  new_country: {
    label: 'New to a country',
    cards: [
      {
        key: 'settle',
        title: 'What do I need to sort out?',
        detail: () => 'Visa, bank, health care and housing, as a checklist',
        prompt:
          "I'm new to this country. What do I need to sort out this month: visa, bank, health care and housing? Ask me where I live now, then make me a checklist.",
        icon: 'list-check',
      },
      {
        key: 'letter',
        title: 'Explain a letter',
        detail: assistant => `${assistant} tells you what it says and whether you need to act`,
        prompt:
          "I got a letter in a language I don't read well. Help me understand it and tell me if I need to do anything.",
        icon: 'file',
      },
      {
        key: 'family-doctor',
        title: 'Find a doctor near me',
        detail: () => 'A family doctor nearby, and how to register',
        prompt: 'Help me find a family doctor near where I live, and tell me how to register.',
        icon: 'map-pin',
        needs: ['maps'],
      },
      {
        key: 'language',
        title: 'Practice the language',
        detail: () => 'Ten minutes on what you need, like the doctor or the bakery',
        prompt:
          'Help me practice the local language for ten minutes. Ask me what I need it for, like the doctor or the bakery.',
        icon: 'message-square-text',
      },
      {
        key: 'newcomers',
        title: 'What newcomers get wrong',
        detail: () => 'Everyday things that surprise people who just arrived',
        prompt: 'What do newcomers here often get wrong in everyday life? Ask me where I live first.',
        icon: 'lightbulb',
      },
      {
        key: 'neighborhood',
        title: 'Choose a neighborhood',
        detail: () => 'A few options compared on rent, commute and feel',
        prompt:
          'Help me choose a neighborhood to live in. Ask me what matters to me, then compare a few options on rent, commute and feel.',
        icon: 'search',
      },
    ],
  },
  work_money: {
    label: 'Work and money',
    cards: [
      {
        key: 'subscriptions',
        title: 'Find forgotten subscriptions',
        detail: () => 'What you pay for, how much and how often',
        prompt:
          "Look through my email for subscriptions and renewals. List what I'm paying for, how much and how often, and flag anything I may have forgotten about.",
        icon: 'dollar-sign',
        needs: ['email'],
      },
      {
        key: 'invoices',
        title: 'Chase unpaid invoices',
        detail: () => 'Which invoices are unpaid, and who to remind',
        prompt: 'Which of my invoices are unpaid, and who should I chase? Check my email.',
        icon: 'dollar-sign',
        needs: ['email'],
      },
      {
        key: 'budget',
        title: 'Make a simple budget',
        detail: assistant => `${assistant} asks what comes in and goes out, then shows it as a chart`,
        prompt: 'Help me make a simple monthly budget. Ask me what comes in and what goes out, and show it as a chart.',
        icon: 'chart',
      },
      {
        key: 'meeting',
        title: 'Get ready for a meeting',
        detail: () => 'Who is in it, what it is about, and three things to say',
        prompt: 'Help me get ready for my next meeting: who is in it, what it is about, and three things I should say.',
        icon: 'calendar-clock',
        needs: ['calendar'],
      },
      {
        key: 'tricky-email',
        title: 'Write a tricky email',
        detail: () => 'Polite but firm, after you say what happened',
        prompt:
          'Help me write a polite but firm email about something that is bothering me at work. Ask me what happened first.',
        icon: 'square-pen',
      },
      {
        key: 'raise',
        title: 'Prepare to ask for a raise',
        detail: () => 'Your wins in plain words, and what to say',
        prompt:
          'Help me prepare to ask for a raise. Ask me about my role and what I have done this year, then help me write down my wins and what to say.',
        icon: 'chart',
      },
      PLAN_DAY,
    ],
  },
};

/** The four cards for the chosen topic, or the general set when none is chosen. */
export function homeCardsFor({
  topic,
  capabilities,
}: {
  topic: HomeTopicId | null;
  capabilities: TourCapabilities;
}): TourPrompt[] {
  const cards = topic === null ? GENERAL_CARDS : HOME_TOPICS[topic].cards;
  return visibleTourPrompts(cards, capabilities).slice(0, HOME_CARD_COUNT);
}
