import { MORNING_BRIEF_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { HELP_AREA_IDS, type HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

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

/**
 * One example card on the home: pressing it puts `prompt` in the composer, and nothing sends until the
 * person does. Every prompt is directive enough to get a full answer on the first try, even from a slow
 * local model: it says what to look at, what to produce and how long, and what to ask before acting.
 */
export type TourPrompt = {
  key: string;
  title: string;
  /** One short line under the title, naming the assistant by its display name. */
  detail: (assistant: string) => string;
  prompt: string;
  /** Words from `prompt` that name what the assistant looks at: a calendar, email, a space, or what the person says. */
  source: string;
  /** Words from `prompt` that name what the assistant produces. */
  output: string;
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

const PLAN_DAY: TourPrompt = {
  key: 'plan-day',
  title: 'Plan my day',
  detail: () => 'The three things that matter, your free time, and what to prepare',
  prompt:
    'Look at my calendar for today and my unread email from the last day. Give me a short plan: the three things that matter most, when I have free time, and anything I need to prepare. Keep it under ten lines.',
  source: 'my calendar for today',
  output: 'a short plan',
  icon: 'calendar-clock',
};

/** The cards shown when no topic pill is chosen. */
export const GENERAL_CARDS: readonly TourPrompt[] = [
  {
    key: 'reply',
    title: 'Draft a reply',
    detail: () => 'Reads the thread, writes it in your voice, asks before sending',
    prompt:
      'Find my most recent email that needs a reply. Read the whole thread, then draft a short reply in my voice. Show me the draft and ask before sending.',
    source: 'my most recent email that needs a reply',
    output: 'a short reply in my voice',
    icon: 'square-pen',
  },
  PLAN_DAY,
  {
    key: 'places',
    title: 'Find places and routes',
    detail: () => 'Three options on a map, with travel time and opening hours',
    prompt:
      'Find three good options near me for what I describe next, with how long it takes to get there and opening hours. Show them on a map.',
    source: 'what I describe next',
    output: 'three good options',
    icon: 'map-pin',
  },
  {
    key: 'schedule',
    title: 'Run things on a schedule',
    detail: () => 'A short morning brief on weekdays, set up with you',
    prompt:
      "Set up a short morning brief for weekdays at 7:30: today's calendar, emails that need me, and the weather. Show me the schedule and ask before saving it.",
    source: "today's calendar",
    output: 'a short morning brief',
    icon: 'clock',
  },
];

/** The topic pills, in the order the home shows them. */
export const HOME_TOPIC_IDS = ['productivity', 'family', 'new_country'] as const;

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
        source: 'calendar',
        output: 'digest',
        icon: 'book-open',
      },
      PLAN_DAY,
      {
        key: 'clear-head',
        title: 'Clear my head',
        detail: assistant => `${assistant} asks what is on your mind and sorts it into today, this week and later`,
        prompt:
          "Ask me what is on my mind, one question at a time, until I say I'm done. Then sort everything I told you into three short lists: today, this week, and later. Keep each item to one line, and ask before saving the lists to a space.",
        source: 'everything I told you',
        output: 'three short lists',
        icon: 'lightbulb',
      },
      {
        key: 'break-task',
        title: 'Break a task into steps',
        detail: () => 'Five to eight steps of about ten minutes each',
        prompt:
          "Ask me which task I'm stuck on. Then split it into five to eight small steps, each something I can do in about ten minutes, as a numbered list. Ask before saving the list to a space.",
        source: "which task I'm stuck on",
        output: 'five to eight small steps',
        icon: 'list-check',
      },
      {
        key: 'forgot',
        title: 'What did I forget?',
        detail: () => 'Promises, replies and things you owe, from your mail and calendar',
        prompt:
          'Look at my email and calendar from the last two weeks for anything I promised, owe, or still need to reply to. Give me a list of up to ten items, each with who it is for and when it was due. Ask before replying to anyone.',
        source: 'my email and calendar from the last two weeks',
        output: 'a list of up to ten items',
        icon: 'circle-check',
        needs: ['email', 'calendar'],
      },
      {
        key: 'meeting',
        title: 'Get ready for a meeting',
        detail: () => 'Who is in it, what it is about, and three things to say',
        prompt:
          'Look at my calendar for my next meeting, and at my email about it. Give me a short brief: who is coming, what it is about, and three things I should say. Keep it under ten lines.',
        source: 'my calendar for my next meeting',
        output: 'a short brief',
        icon: 'calendar-clock',
        needs: ['calendar'],
      },
      {
        key: 'subscriptions',
        title: 'Find forgotten subscriptions',
        detail: () => 'What you pay for, how much and how often',
        prompt:
          'Look through my email from the last year for subscriptions and renewals. Give me a table of what I pay for, how much, and how often, and mark anything I may have forgotten. Ask before cancelling or replying to anything.',
        source: 'my email from the last year',
        output: 'a table of what I pay for',
        icon: 'dollar-sign',
        needs: ['email'],
      },
      {
        key: 'tricky-email',
        title: 'Write a tricky email',
        detail: () => 'Polite but firm, after you say what happened',
        prompt:
          'Ask me what happened and who the email is for. Then draft a short, polite but firm email in my voice, under 150 words. Show me the draft and ask before sending.',
        source: 'what happened',
        output: 'a short, polite but firm email',
        icon: 'square-pen',
      },
      {
        key: 'get-started',
        title: 'Help me get started',
        detail: () => 'One small thing you can finish in 25 minutes',
        prompt:
          'Ask me what I am putting off. Then pick the one smallest step I can finish in 25 minutes, and tell me how to begin in three short lines.',
        source: 'what I am putting off',
        output: 'the one smallest step',
        icon: 'play',
      },
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
          'Look at my calendar and email for the next seven days. Give me one list of what is coming up for my family: school, appointments, birthdays and bills, each with its day. Keep it under fifteen lines.',
        source: 'my calendar and email for the next seven days',
        output: 'one list',
        icon: 'calendar',
        needs: ['calendar', 'email'],
      },
      {
        key: 'meals',
        title: "Plan this week's meals",
        detail: () => 'Dinners around what you have, and one shopping list',
        prompt:
          'Ask me what is in the fridge and cupboards, and how many people are eating. Then plan dinners for the next seven days and give me one shopping list grouped by aisle. Ask before saving the plan to a space.',
        source: 'what is in the fridge and cupboards',
        output: 'one shopping list',
        icon: 'list-check',
      },
      {
        key: 'care-track',
        title: "Keep track of someone's care",
        detail: assistant => `Medicines, appointments and questions, kept in one place by ${assistant}`,
        prompt:
          'Ask me who I care for, their medicines with times, and their coming appointments. Then put it all in one space with three short sections: medicines, appointments, and questions for the doctor. Ask before creating the space.',
        source: 'who I care for',
        output: 'three short sections',
        icon: 'list-check',
      },
      {
        key: 'appointment',
        title: "Doctor's appointments",
        detail: () => 'What is coming up, what to bring and what to ask',
        prompt:
          "Look at my calendar and email for doctor's appointments in the next month. For each one, list the date, what to bring, and two or three questions to ask. Ask before booking or changing anything.",
        source: "my calendar and email for doctor's appointments",
        output: 'list the date, what to bring',
        icon: 'calendar',
        needs: ['calendar', 'email'],
      },
      {
        key: 'medicine',
        title: 'Make a medicine schedule',
        detail: assistant => `A daily schedule, and ${assistant} reminds you when each one is due`,
        prompt:
          'Ask me the medicines, doses and times for the person I care for. Then give me a simple daily schedule as a table, and ask before setting up reminders for when each one is due.',
        source: 'the medicines, doses and times',
        output: 'a simple daily schedule',
        icon: 'clock',
      },
      {
        key: 'care-visit',
        title: 'Prepare for a care visit',
        detail: () => 'What to tell the doctor, and what to ask',
        prompt:
          'Ask me who the visit is for and what has changed since the last one. Then write a short note for the doctor, under ten lines, and a list of questions to ask.',
        source: 'what has changed since the last one',
        output: 'a short note for the doctor',
        icon: 'square-pen',
      },
      {
        key: 'chores',
        title: 'Split the chores fairly',
        detail: assistant => `${assistant} asks who lives with you and makes a weekly chart`,
        prompt:
          'Ask me who lives here and which chores need doing. Then make a weekly chart that splits them fairly, as a table with one row per person. Ask before saving it to a space.',
        source: 'who lives here',
        output: 'a weekly chart',
        icon: 'broom',
      },
      {
        key: 'birthday',
        title: 'Plan a birthday',
        detail: () => 'A to-do list and a timeline for the day',
        prompt:
          'Ask me who it is for, the date and the budget. Then give me a to-do list and a timeline for the day, each under ten items. Ask before adding anything to my calendar.',
        source: 'who it is for, the date and the budget',
        output: 'a to-do list and a timeline',
        icon: 'calendar-plus',
      },
      {
        key: 'outing',
        title: 'Plan a weekend outing',
        detail: () => 'Three places nearby, with travel time and opening hours',
        prompt:
          'Ask me who is coming and what they like. Then find three places near me, with how long it takes to get there and opening hours. Show them on a map.',
        source: 'who is coming and what they like',
        output: 'three places near me',
        icon: 'map-pin',
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
          'Ask me which country and city I live in, and when I arrived. Then give me a checklist for this month covering visa, bank, health care and housing, with one line on how to do each. Keep it under fifteen lines.',
        source: 'which country and city I live in',
        output: 'a checklist for this month',
        icon: 'list-check',
      },
      {
        key: 'letter',
        title: 'Explain a letter',
        detail: assistant => `${assistant} tells you what it says and whether you need to act`,
        prompt:
          'I will paste or describe a letter next. Tell me in plain words what it says, whether I need to act, and by when. Keep it under eight lines, and ask before writing a reply.',
        source: 'a letter',
        output: 'what it says, whether I need to act, and by when',
        icon: 'file',
      },
      {
        key: 'family-doctor',
        title: 'Find a doctor near me',
        detail: () => 'Family doctors nearby, and how to register',
        prompt:
          'Find three family doctors near me that take new patients, with how long it takes to get there and opening hours. Show them on a map, and tell me how to register.',
        source: 'near me',
        output: 'three family doctors',
        icon: 'map-pin',
        needs: ['maps'],
      },
      {
        key: 'language',
        title: 'Practice the language',
        detail: () => 'Ten minutes on what you need, like the doctor or the bakery',
        prompt:
          'Ask me which language I am learning and what I need it for, like the doctor or the bakery. Then run a ten-minute practice: one short line from you, one from me, and correct my mistakes gently after each turn.',
        source: 'what I need it for',
        output: 'a ten-minute practice',
        icon: 'message-square-text',
      },
      {
        key: 'newcomers',
        title: 'What newcomers get wrong',
        detail: () => 'Everyday things that surprise people who just arrived',
        prompt:
          'Ask me which country and city I live in. Then list the five everyday things newcomers there most often get wrong, each in one or two lines.',
        source: 'which country and city I live in',
        output: 'the five everyday things',
        icon: 'lightbulb',
      },
      {
        key: 'neighborhood',
        title: 'Choose a neighborhood',
        detail: () => 'Three options compared on rent, commute and feel',
        prompt:
          'Ask me the city, my budget, and where I work. Then compare three neighborhoods in a short table: rent, commute time, and what living there is like.',
        source: 'the city, my budget, and where I work',
        output: 'a short table',
        icon: 'search',
      },
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

/** The saved help areas that still show as a home pill; the others stay stored but are no longer offered. */
export const HOME_HELP_AREA_IDS: readonly (HelpAreaId & HomeTopicId)[] = HELP_AREA_IDS.filter(
  (id): id is HelpAreaId & HomeTopicId => isHomeTopicId(id),
);
