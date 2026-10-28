import { MORNING_BRIEF_CARD_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import type { HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

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

/** One example card on the home: pressing it puts its text in the composer, and nothing sends until the person does. */
export type TourCard = {
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

/** What a card puts in the composer: its prompt, with nothing added to it. */
export function composerTextFor(card: TourCard): string {
  return card.prompt;
}

/** The examples whose capability this instance has; the rest are left out, not greyed out. */
export function visibleTourCards(cards: readonly TourCard[], capabilities: TourCapabilities): TourCard[] {
  return cards.filter(item => item.needs === undefined || item.needs.some(name => capabilities[name]));
}

/** Every card, defined once; the default list and the pills only name them. */
export const CARDS = {
  brief: {
    title: 'Your morning brief',
    detail: assistant => `${assistant} gathers your mail, calendar and to-dos into one note each morning`,
    prompt: MORNING_BRIEF_CARD_PROMPT,
    icon: 'book-open',
    needs: ['calendar', 'email'],
  },
  today: {
    title: 'Just tell me what matters today',
    detail: () => 'Three things, your free hour, and what to bring',
    prompt:
      'Look at my calendar for today and unread email from the last day. Tell me the three things that matter most, when I have a free stretch, and anything I need to bring or prepare. Flag anything that looks off, like a clash or a reply that is overdue. Then ask if I want this every weekday morning.',
    icon: 'calendar-clock',
    needs: ['calendar', 'email'],
  },
  dropping: {
    title: 'What am I dropping?',
    detail: () => 'Replies, promises, forms and RSVPs you still owe',
    prompt:
      'Look through my email from the last two weeks for anything I owe someone: a reply, a promise, a form, an RSVP, a payment. List up to ten, each with who it is for and when it was due, most overdue first. Then ask which one I want to deal with now, and help with that one. Ask before replying to anyone.',
    icon: 'circle-check',
    needs: ['email'],
  },
  head: {
    title: "Everything's in my head",
    detail: assistant => `Say it all out loud. ${assistant} sorts it`,
    prompt:
      "I have a lot on my mind and I want to get it out of my head. Can I say it all out loud while you keep track of it? When I say I'm done, sort it into three lists for me: today, this week and later. Ask me before saving the lists to a space, and check in with me tomorrow on the today list.",
    icon: 'lightbulb',
  },
  start: {
    title: "I can't get started",
    detail: assistant => `Tell ${assistant} what's stuck. Start small`,
    prompt:
      "I'm stuck on something and I can't get started. Ask me what it is. Then suggest one small first step I could do in about ten minutes, and tell me plainly how to begin. If I say that is still too much, make the step smaller without making a fuss about it. Just the first step for now, please. When I have done the first step, ask if I want the next one.",
    icon: 'play',
  },
  kindly: {
    title: 'Say it kindly',
    detail: () => 'The awkward message, written for you',
    prompt:
      'I need to write a message that could come out wrong, and I want to say it kindly. Ask me who it is for and what happened, then write a short message that sounds like me: match how I write in my own sent emails if you can see them, otherwise plain and friendly. Kind, clear, and firm where it needs to be. Show it to me first; I might ask you to make it softer, firmer or shorter. Ask me before sending anything.',
    icon: 'square-pen',
  },
  dinner: {
    title: "What's for dinner this week?",
    detail: () => 'Seven dinners and one shopping list',
    prompt:
      "Plan this week's dinners and give me one shopping list grouped by aisle. Start from what's already in the fridge and cupboards; if you don't know what's there, ask me. If you don't know who is eating, ask me who is eating and whether anyone has an allergy or a food they won't eat. Keep weeknights under 30 minutes, use up anything that will spoil first. Offer to save the plan where I can tick it off, and save it only after I say yes. I'd like to do it again next weekend.",
    icon: 'list-check',
  },
  waiting: {
    title: "Answer the one that's waiting",
    detail: assistant => `${assistant} finds the reply you've been avoiding and drafts it`,
    prompt:
      'Find the oldest email in my inbox that is clearly waiting on a reply from me. Tell me briefly what it is and why it matters. Then draft a short reply that matches how I wrote earlier in the thread and show it to me. Ask before sending. Then ask if I want the next one.',
    icon: 'square-pen',
    needs: ['email'],
  },
  forms: {
    title: 'Forms and paperwork',
    detail: () => 'Anything with a deadline you have to fill in or sign',
    prompt:
      'Look through my email from the last month for forms, documents to sign, renewals and anything with a due date. List them with the due date and what is needed from me, soonest first. Ask which one to start with, then walk me through that one, one field at a time.',
    icon: 'file',
    needs: ['email'],
  },
  thread: {
    title: 'Catch me up on a thread',
    detail: () => 'A long thread in five lines, and what you need to do',
    prompt:
      'Ask me which thread, or take the longest unread one. Read all of it, then give me the short version: what happened, what is being asked of me, and by when. Then ask if I want a reply drafted.',
    icon: 'message-square-text',
    needs: ['email'],
  },
  fresh: {
    title: 'Give me a fresh start',
    detail: () => 'Pick three things to finish today and let the rest wait',
    prompt:
      'Ask me what is weighing on me, one thing at a time. When I\'m done, help me pick the three I should finish today and tell me why those three. The rest can go on a "later" list, no judgment. Ask me before saving the lists, and check back with me at the end of the day.',
    icon: 'broom',
  },
  next_meeting: {
    title: 'Get me ready for the next one',
    detail: () => "Who's in it, what it's about, three things to say",
    prompt:
      'Look at my next meeting or appointment on the calendar and any email about it. Tell me who will be there, what it is about, and three things I should say or ask. Ask if I want a reminder 15 minutes before with this note.',
    icon: 'calendar-clock',
    needs: ['calendar'],
  },
  week: {
    title: 'This week at a glance',
    detail: () => 'Appointments, school, birthdays and bills in one list',
    prompt:
      'Look at my calendar and email for the next seven days. Give me one list of what is coming up, each with its day: appointments, school and family things, birthdays, bills and deadlines. Mark anything that overlaps or looks wrong. Ask if I want this every Sunday evening.',
    icon: 'calendar',
    needs: ['calendar', 'email'],
  },
  gathering: {
    title: 'Plan a birthday or a gathering',
    detail: () => "A to-do list and the day's timeline",
    prompt:
      "Ask me who it is for, the date, roughly how many people, and the budget. If I skip one, assume the usual and just say what you assumed. Then give me a short to-do list in the order to do things, and a timeline for the day. Ask me before adding anything to my calendar, and I'd like reminders for the two or three things that must happen early.",
    icon: 'calendar-plus',
  },
  trip: {
    title: 'A trip is coming',
    detail: () => 'What to book, pack and sort out, in the right order',
    prompt:
      "Help me get ready for a trip. Ask me where I'm going and when, and who with only if it changes the plan. Then make my checklist from what I actually told you: what to book now, what to sort out before I go, and what to pack. Scale it to the time I have left. Each line is one concrete thing to do. If I leave today or this week, skip the parts that no longer fit and say so in one line.",
    icon: 'list-check',
  },
  remember: {
    title: "Don't let me forget",
    detail: assistant => `${assistant} reminds you at the right moment`,
    prompt:
      'Ask me what I must not forget and when it matters. Suggest the right time to remind me, usually the evening before and the morning of, and ask before setting it. Then ask if there is anything else.',
    icon: 'clock',
  },
  places: {
    title: 'Find places and routes',
    detail: () => 'Three options, travel time and hours',
    prompt:
      "Ask me what I'm looking for, when I want to go, and where I'm starting from, unless you already know. Search for three good options near there, each with how long it takes to get there, opening hours and a link. Show them on a map. Ask if I want one added to my calendar.",
    icon: 'map-pin',
    needs: ['maps'],
  },
  say_no: {
    title: 'Say no',
    detail: () => 'A clear no that keeps the relationship',
    prompt:
      "Ask me what I'm being asked to do and who is asking. Then write a short, warm, clear no that sounds like me (match my own sent emails if you can see them, otherwise plain and friendly), without over-explaining. Only offer an alternative if I say there is one. Show it to me and ask before sending.",
    icon: 'square-pen',
  },
  ask_for: {
    title: 'Ask for something',
    detail: () => 'A raise, a refund, a favor. No apologies',
    prompt:
      "Ask me what I'm asking for and from whom. Then write a short, direct request that sounds like me (match my own sent emails if you can see them, otherwise plain and friendly), saying what I want, why it is reasonable, and what I'd like to happen next, with no apologies in it. Show it to me and ask before sending.",
    icon: 'square-pen',
  },
  follow_up: {
    title: 'Follow up without nagging',
    detail: () => 'A polite nudge that is easy to answer',
    prompt:
      "Ask me who I'm following up with and what I'm waiting on, or find the thread if I name it. Write a short, friendly follow-up that is easy to answer in one word. Ask before sending, and remind me again in a week if there's no answer.",
    icon: 'clock-rotate-left',
  },
  thanks: {
    title: 'Thank someone properly',
    detail: () => 'A thank-you that sounds like you, not a card from the shop',
    prompt:
      'Ask me who it is for and what they did. Then write a short thank-you, specific to what they did, that sounds like me (match my own sent emails if you can see them, otherwise warm and plain). Show it to me and ask before sending.',
    icon: 'message-square-text',
  },
  explain: {
    title: 'Explain this to me',
    detail: assistant => `Paste a letter or message. ${assistant} tells you what it means and what to do`,
    prompt:
      'I will paste or describe a letter, message or document next. Tell me in plain words what it says, whether I need to do anything, and by when. Ask before writing any reply.',
    icon: 'file',
  },
  decide: {
    title: 'Help me decide',
    detail: () => 'Two options and a pick you can ignore',
    prompt:
      "I'm trying to decide something. Ask me what I'm deciding between, and what matters most to me about it. Then lay the options out side by side on those things, and tell me which one you'd pick and why.",
    icon: 'sliders',
  },
  talk: {
    title: 'Talk it through',
    detail: assistant => `${assistant} listens and asks one good question at a time`,
    prompt:
      "There's something I want to talk through. Ask me what's going on, then mostly listen and ask me one good question at a time to help me think it through, until I say I've got it or I'm done. If I want advice, I'll ask for it. At the end, offer to write down what I decided.",
    icon: 'message-square-text',
  },
  steps: {
    title: 'Break it into steps',
    detail: () => 'A big thing split into small ones you can tick off',
    prompt:
      'Ask me what the big thing is and when it needs to be done. Then split it into five to eight steps, each something I can do in one sitting, in order, with a rough day for each. Ask before saving it as a list I can tick off, and check in with me after the first step.',
    icon: 'list-check',
  },
  company: {
    title: 'Keep me company while I work',
    detail: assistant => `Set a timer. ${assistant} checks in when it ends, nothing more`,
    prompt:
      'I want company while I work. Ask me what I\'m about to work on and for how long, suggesting 25 minutes if I\'m not sure. Then just say "go". While I work, stay quiet unless I speak to you, and then answer what I actually said. When the time is up, ask me how it went and whether I want another round.',
    icon: 'clock',
  },
  care: {
    title: 'Keep their care in one place',
    detail: () => 'Medicines, visits and questions in one place',
    prompt:
      "Keep everything about someone I look after in one place: medicines and times, upcoming appointments, and questions for the next visit. Ask me who it is and what I'd like to track, then put it in one space with those three sections. Ask before creating it, and I'd like reminders for the medicine times.",
    icon: 'folder',
  },
  meds: {
    title: 'Medicine times',
    detail: () => 'A daily schedule with reminders',
    prompt:
      'Ask me the medicines, doses and times, one at a time. Use them exactly as I give them and never suggest changes; if something looks wrong, tell me to check with a pharmacist. Then show me a simple daily table. Ask before setting a reminder for each time. The reminders come to me; if someone else gives the medicine, tell me I can pass them on.',
    icon: 'clock',
  },
  their_appointment: {
    title: 'Get ready for their appointment',
    detail: () => 'What to bring, what has changed, and what to ask',
    prompt:
      'Find their next appointment in my calendar or email, or ask me when it is. Ask me what has changed since the last visit. Then write a short note to bring, and three questions to ask. Ask if I want it saved and a reminder the evening before.',
    icon: 'calendar',
    needs: ['calendar', 'email'],
  },
  school: {
    title: 'School and activities this week',
    detail: () => 'Pickups, forms, events and what to send in, by day',
    prompt:
      'Look at my calendar and email for the next seven days for anything about school, clubs or activities: pickups, forms, events, things to send in. List them by day, and mark anything that needs an answer from me. Ask if I want this every Sunday.',
    icon: 'calendar',
    needs: ['calendar', 'email'],
  },
  chores: {
    title: 'Share the load at home',
    detail: () => 'Who does what this week, as a chart you can share',
    prompt:
      "Ask me who lives here and which jobs need doing each week. Make a fair weekly chart, one row per person, that rotates the jobs nobody likes and that I can share with the others. Ask me before saving it to a space, and I'd like it re-shuffled every month.",
    icon: 'broom',
  },
  hard_talk: {
    title: 'A hard conversation about care',
    detail: assistant => `${assistant} helps you find the words`,
    prompt:
      'Ask me who the conversation is with and what I need from it. Then help me write three or four short lines I can say to open it, honest and kind, and one line for if it goes badly. Ask if I want to practice it with you first.',
    icon: 'message-square-text',
  },
  subscriptions: {
    title: 'What am I paying for every month?',
    detail: () => 'Subscriptions and renewals from your email, with what you may have forgotten',
    prompt:
      'Look through my email from the last year for subscriptions, renewals and recurring charges. Give me a table of what I pay for, how much and how often, and mark anything that looks forgotten or doubled. Ask which ones I want to cancel, then help with one at a time. Ask before sending anything.',
    icon: 'dollar-sign',
    needs: ['email'],
  },
  bill: {
    title: 'Explain this bill',
    detail: assistant => `${assistant} says what you owe and why`,
    prompt:
      'I will paste or describe a bill or statement next. Tell me in plain words what I owe, what it is for, when it is due, and anything that looks wrong or higher than usual. Ask before drafting any dispute or reply.',
    icon: 'file',
  },
  overcharged: {
    title: 'Am I being overcharged?',
    detail: () => 'Compare your price with what others pay',
    prompt:
      "Ask me what the service is and what I pay. Search for what people typically pay for the same thing, and tell me briefly whether mine looks high, about right, or low, with a source. If it looks high, I'd like a short message drafted asking for a better rate. Ask me before sending anything.",
    icon: 'search',
  },
  money_due: {
    title: 'Money coming up',
    detail: () => 'Bills, renewals and payments due in the next month, by date',
    prompt:
      'Look at my email and calendar for bills, renewals and payments due in the next 30 days. List them by date with the amount if you can see it. Mark any that are overdue. Ask if I want reminders two days before each, and if I want this list every month.',
    icon: 'calendar-clock',
    needs: ['calendar', 'email'],
  },
  budget: {
    title: 'A simple budget for this month',
    detail: () => 'What comes in, goes out, and is left',
    prompt:
      "Ask me what comes in this month and the fixed things that must go out, one at a time, rounding is fine. If I'm not sure of a number, use a round guess and say it's a guess. Show me three numbers: in, must-pay, left over. Then ask me if I want to set aside anything from what's left. Ask me before saving the budget, and check in with me mid-month.",
    icon: 'chart',
  },
  sort_out: {
    title: 'What do I need to sort out first?',
    detail: () => 'Papers, bank, health care, housing',
    prompt:
      "Ask me which country and city I live in, and when I arrived. If I can't give you one of these, carry on with what you have and say which part is missing. Then search official government pages and give me a checklist for this month covering papers and registration, bank, health care and housing, with one line on how to do each and a link to the official page, in the order to do them. Say which items you could not confirm. Ask before saving it, and remind me of the next item each Monday.",
    icon: 'list-check',
  },
  letter: {
    title: 'Explain this letter',
    detail: assistant => `${assistant} says what it means and what to do`,
    prompt:
      'I will paste or describe a letter next. Tell me in plain words what it says, whether I need to act, and by when. Ask before writing a reply. If I need it, translate it for me line by line.',
    icon: 'file',
  },
  doctor: {
    title: 'Find a doctor near me',
    detail: () => 'Nearby doctors taking new patients',
    prompt:
      'Ask me where I live, unless you already know. Then search for three family doctors near there that take new patients, each with how long it takes to get there, opening hours and a link. Show them on a map and tell me how to register with one, step by step, from the official health service page. Ask before booking anything.',
    icon: 'map-pin',
    needs: ['maps'],
  },
  language: {
    title: 'Ten minutes of the language',
    detail: () => 'Practice the pharmacy or the school office',
    prompt:
      "Ask me which language and what I need it for this week, like the pharmacy, the school office or the landlord. Then run a ten-minute practice: one short line from you, one from me, and gently correct my mistakes after each turn. I'd like to do ten minutes again tomorrow.",
    icon: 'message-square-text',
  },
  locals_know: {
    title: 'What people here just know',
    detail: () => 'The everyday things nobody tells newcomers',
    prompt:
      "Ask me which country and city. Then search recent advice from people who live there and tell me the five everyday things newcomers most often get wrong or don't know, with a link for each. Ask if I want the five for a specific situation next, like renting, schools or getting around.",
    icon: 'lightbulb',
  },
  neighborhood: {
    title: 'Choose a neighborhood',
    detail: () => "Three options compared on rent, commute and what it's like to live there",
    prompt:
      "Ask me the city, my budget, and where I'll spend most of my days. If I skip one, use what you have and say what you assumed. Search current rents and travel times, and compare three neighborhoods for me: the rent, with a source, the commute time, and what living there is like. Ask me if I want to see them on a map.",
    icon: 'search',
  },
} satisfies Record<string, TourCard>;

export type CardKey = keyof typeof CARDS;

/** The cards shown when no pill is chosen, in the order they are tried. */
export const DEFAULT_CARD_KEYS: readonly CardKey[] = [
  'brief',
  'today',
  'dropping',
  'head',
  'start',
  'kindly',
  'dinner',
];

/** The pills, in the order the home shows them. */
export const HOME_TOPIC_IDS = [
  'behind',
  'coming_up',
  'write_hard',
  'help_me_think',
  'someone_i_look_after',
  'money',
  'just_moved',
] as const;

export type HomeTopicId = (typeof HOME_TOPIC_IDS)[number];

export const HOME_TOPICS: Record<HomeTopicId, { label: string; cards: readonly CardKey[] }> = {
  behind: { label: "I'm behind", cards: ['dropping', 'waiting', 'forms', 'thread', 'head', 'fresh'] },
  coming_up: {
    label: "Something's coming up",
    cards: ['next_meeting', 'week', 'gathering', 'trip', 'remember', 'places'],
  },
  write_hard: {
    label: 'I need to write something hard',
    cards: ['kindly', 'say_no', 'ask_for', 'follow_up', 'thanks', 'explain'],
  },
  help_me_think: { label: 'Help me think', cards: ['head', 'start', 'decide', 'talk', 'steps', 'company'] },
  someone_i_look_after: {
    label: 'Someone I look after',
    cards: ['care', 'meds', 'their_appointment', 'school', 'chores', 'hard_talk'],
  },
  money: { label: 'Money', cards: ['subscriptions', 'bill', 'overcharged', 'money_due', 'budget'] },
  just_moved: {
    label: 'I just moved here',
    cards: ['sort_out', 'letter', 'doctor', 'language', 'locals_know', 'neighborhood'],
  },
};

export function isHomeTopicId(value: string): value is HomeTopicId {
  return HOME_TOPIC_IDS.some(id => id === value);
}

/** The four cards for the chosen pill, or the default set when none is chosen; capability gaps fall through to the next. */
export function homeCardsFor({
  topic,
  capabilities,
}: {
  topic: HomeTopicId | null;
  capabilities: TourCapabilities;
}): TourCard[] {
  const keys = topic === null ? DEFAULT_CARD_KEYS : HOME_TOPICS[topic].cards;
  return visibleTourCards(
    keys.map(key => CARDS[key]),
    capabilities,
  ).slice(0, HOME_CARD_COUNT);
}

/** The pill each help area chosen in setup leads to; the one table that ties profile choices to the home. */
export const HELP_AREA_TOPIC: Record<HelpAreaId, HomeTopicId> = {
  focus: 'help_me_think',
  family: 'someone_i_look_after',
  caring: 'someone_i_look_after',
  new_country: 'just_moved',
  work_money: 'money',
};
