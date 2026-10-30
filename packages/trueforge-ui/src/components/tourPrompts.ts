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

/** What a home card shows: an icon, a title, and one short line under it. */
export type TourCardFace = {
  title: string;
  /** One short line under the title, naming the assistant by its display name. */
  detail: (assistant: string) => string;
  icon: string;
};

/** One example card on the home: pressing it puts its text in the composer, and nothing sends until the person does. */
export type TourCard = TourCardFace & {
  prompt: string;
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
      'I want to know what matters today. Look at my calendar for today and my unread email from the last day, then tell me the three things that matter most, when I have a free stretch, and anything I need to bring or prepare. Point out anything that looks off, like a clash or a reply that is overdue. At the end, offer to do this every weekday morning, and set it up only after I say yes.',
    icon: 'calendar-clock',
    needs: ['calendar', 'email'],
  },
  dropping: {
    title: 'What am I dropping?',
    detail: () => 'Replies, promises, forms and RSVPs you still owe',
    prompt:
      'I think I am dropping things. Look through my email from the last two weeks for anything I owe someone, like a reply, a promise, a form, an RSVP or a payment, and list up to ten with who it is for and when it was due, most overdue first. Then ask which one I want to deal with now and help me with that one. Show me any reply before it goes out and wait for my OK.',
    icon: 'circle-check',
    needs: ['email'],
  },
  head: {
    title: "Everything's in my head",
    detail: assistant => `Say it all out loud. ${assistant} sorts it`,
    prompt:
      'I have a lot on my mind and I want to get it out of my head. I will say it all while you keep track, and when I say I am done, sort it into three lists for me: today, this week and later. Then offer to save the lists to a space and to check in with me tomorrow on the today list, and do that only after I say yes.',
    icon: 'lightbulb',
  },
  start: {
    title: "I can't get started",
    detail: assistant => `Tell ${assistant} what's stuck. Start small`,
    prompt:
      'I am stuck on something and I cannot get started. In one short message, ask me what it is. Then suggest one small first step I could do in about ten minutes and tell me plainly how to begin; if I say that is still too much, make the step smaller without making a fuss about it. When I have done it, ask if I want the next one.',
    icon: 'play',
  },
  kindly: {
    title: 'Say it kindly',
    detail: () => 'The awkward message, written for you',
    prompt:
      'I need to write a message that could come out wrong, and I want to say it kindly. In one short message, ask me who it is for and what happened. Then write a short message that sounds like me, matching how I write in my sent emails if you can see them: kind, clear, and firm where it needs to be. Show me the draft and wait for my OK; I might ask you to make it softer, firmer or shorter.',
    icon: 'square-pen',
  },
  dinner: {
    title: "What's for dinner this week?",
    detail: () => 'Seven dinners and one shopping list',
    prompt:
      "I want this week's dinners planned, with one shopping list grouped by aisle. In one short message, ask me what is already in the fridge and cupboards, who is eating, and whether anyone has an allergy or a food they won't eat, unless you already know. Keep weeknights under 30 minutes and use up anything that will spoil first. Offer to save the plan where I can tick it off and to do this again next weekend, and do that only after I say yes.",
    icon: 'list-check',
  },
  waiting: {
    title: "Answer the one that's waiting",
    detail: assistant => `${assistant} finds the reply you've been avoiding and drafts it`,
    prompt:
      'I have been avoiding a reply. Find the oldest email in my inbox that is clearly waiting on an answer from me and tell me briefly what it is and why it matters. Then draft a short reply that matches how I wrote earlier in the thread. Show me the draft and wait for my OK before sending, then ask if I want the next one.',
    icon: 'square-pen',
    needs: ['email'],
  },
  forms: {
    title: 'Forms and paperwork',
    detail: () => 'Anything with a deadline you have to fill in or sign',
    prompt:
      'I have forms and paperwork to deal with. Look through my email from the last month for forms, documents to sign, renewals and anything with a due date, and list them with the due date and what is needed from me, soonest first. Then ask which one I want to start with and walk me through it.',
    icon: 'file',
    needs: ['email'],
  },
  thread: {
    title: 'Catch me up on a thread',
    detail: () => 'A long thread in five lines, and what you need to do',
    prompt:
      'I need catching up on an email thread. Take the longest unread thread unless I name a different one, read all of it, and give me the short version: what happened, what is being asked of me, and by when. Then offer to draft a reply, and show it to me before anything is sent.',
    icon: 'message-square-text',
    needs: ['email'],
  },
  fresh: {
    title: 'Give me a fresh start',
    detail: () => 'Pick three things to finish today and let the rest wait',
    prompt:
      'I want a fresh start today. In one short message, ask me everything that is weighing on me. Then help me pick the three I should finish today and tell me why those three; the rest go on a later list, no judgment. Offer to save the lists and to check back with me at the end of the day, and do that only after I say yes.',
    icon: 'broom',
  },
  next_meeting: {
    title: 'Get me ready for the next one',
    detail: () => "Who's in it, what it's about, three things to say",
    prompt:
      'I want to be ready for my next meeting. Look at the next meeting or appointment on my calendar and any email about it, then tell me who will be there, what it is about, and three things I should say or ask. Offer a reminder 15 minutes before with this note, and set it only after I say yes.',
    icon: 'calendar-clock',
    needs: ['calendar'],
  },
  week: {
    title: 'This week at a glance',
    detail: () => 'Appointments, school, birthdays and bills in one list',
    prompt:
      'I want to see my week at a glance. Look at my calendar and email for the next seven days and give me one list of what is coming up, each with its day: appointments, school and family things, birthdays, bills and deadlines. Mark anything that overlaps or looks wrong. Offer to do this every Sunday evening, and set it up only after I say yes.',
    icon: 'calendar',
    needs: ['calendar', 'email'],
  },
  gathering: {
    title: 'Plan a birthday or a gathering',
    detail: () => "A to-do list and the day's timeline",
    prompt:
      'I am planning a birthday or a gathering. In one short message, ask me who it is for, the date, roughly how many people, and the budget; if I skip one, assume the usual and say what you assumed. Then give me a short to-do list in the order to do things, and a timeline for the day. Offer to add the key dates to my calendar with reminders for the two or three things that must happen early, and do that only after I say yes.',
    icon: 'calendar-plus',
  },
  trip: {
    title: 'A trip is coming',
    detail: () => 'What to book, pack and sort out, in the right order',
    prompt:
      'I have a trip coming up. In one short message, ask me where I am going and when, then help me get ready: what to book, what to sort out before I go, and what to pack, in the right order for the time I have left.',
    icon: 'list-check',
  },
  remember: {
    title: "Don't let me forget",
    detail: assistant => `${assistant} reminds you at the right moment`,
    prompt:
      'I need a reminder. In one short message, ask me what I must not forget and when it matters, suggest a good time to remind me, and ask before you set it.',
    icon: 'clock',
  },
  places: {
    title: 'Find places and routes',
    detail: () => 'Three options, travel time and hours',
    prompt:
      'I am looking for a place to go. In one short message, ask me what I am looking for, when, and where I am starting from, unless you already know. Then give me three good options with travel time, opening hours and a link, on a map. Ask if I want one on my calendar.',
    icon: 'map-pin',
    needs: ['maps'],
  },
  say_no: {
    title: 'Say no',
    detail: () => 'A clear no that keeps the relationship',
    prompt:
      'I need to say no to something. In one short message, ask me what I am being asked to do and who is asking. Then write a short, warm, clear no in my voice. Offer an alternative only if I say there is one. Show me the draft and wait for my OK.',
    icon: 'square-pen',
  },
  ask_for: {
    title: 'Ask for something',
    detail: () => 'A raise, a refund, a favor. No apologies',
    prompt:
      'I need to ask someone for something. In one short message, ask me what I want and from whom. Then write a short, direct request in my voice, with no apologies. Show me the draft and wait for my OK.',
    icon: 'square-pen',
  },
  follow_up: {
    title: 'Follow up without nagging',
    detail: () => 'A polite nudge that is easy to answer',
    prompt:
      'I am waiting on someone. In one short message, ask me who and what for, or find the thread if I name it. Write a short, friendly follow-up that is easy to answer. Wait for my OK before sending.',
    icon: 'clock-rotate-left',
  },
  thanks: {
    title: 'Thank someone properly',
    detail: () => 'A thank-you that sounds like you, not a card from the shop',
    prompt:
      'I want to thank someone. In one short message, ask me who and what they did. Then write a short thank-you in my voice, specific to what they did. Show me the draft and wait for my OK.',
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
      'I am trying to decide something. In one short message, ask me what I am deciding between and what matters most to me about it. Then lay the options out side by side on those things, and tell me which one you would pick and why.',
    icon: 'sliders',
  },
  talk: {
    title: 'Talk it through',
    detail: assistant => `${assistant} listens and asks one good question at a time`,
    prompt:
      "I want to talk something through. I will tell you what is going on; mostly listen, and ask one good question at a time to help me think, until I say I have got it or I am done. If I want advice, I'll ask for it. At the end, offer to write down what I decided.",
    icon: 'message-square-text',
  },
  steps: {
    title: 'Break it into steps',
    detail: () => 'A big thing split into small ones you can tick off',
    prompt:
      'I have a big thing to do and I want it broken into steps. In one short message, ask me what it is and when it needs to be done. Then split it into five to eight steps I can each do in one sitting, in order, with a rough day for each. Offer to save it as a list I can tick off and to check in with me after the first step, and do that only after I say yes.',
    icon: 'list-check',
  },
  company: {
    title: 'Keep me company while I work',
    detail: assistant => `Set a timer. ${assistant} checks in when it ends, nothing more`,
    prompt:
      'I want company while I work. In one short message, ask me what I am about to work on and for how long, suggesting 25 minutes if I am not sure, then just say go. While I work, stay quiet unless I speak to you, and then answer what I actually said. When the time is up, ask me how it went and whether I want another round.',
    icon: 'clock',
  },
  care: {
    title: 'Keep their care in one place',
    detail: () => 'Medicines, visits and questions in one place',
    prompt:
      'I look after someone and I want everything about their care in one place: medicines and times, upcoming appointments, and questions for the next visit. In one short message, ask me who it is and what I would like to track. Then show me how you would set up one space with those three sections and reminders for the medicine times, and create it only after I say yes.',
    icon: 'folder',
  },
  meds: {
    title: 'Medicine times',
    detail: () => 'A daily schedule with reminders',
    prompt:
      "I need a daily schedule for someone's medicines. In one short message, ask me the medicines, doses and times. Use them exactly as I give them and never suggest changes; if something looks wrong, tell me to check with a pharmacist. Then show me a simple daily table and offer a reminder for each time, and set them only after I say yes.",
    icon: 'clock',
  },
  their_appointment: {
    title: 'Get ready for their appointment',
    detail: () => 'What to bring, what has changed, and what to ask',
    prompt:
      'I am getting someone I look after ready for their appointment. Find their next appointment in my calendar or email, and in one short message ask me what has changed since the last visit, and when the appointment is if you could not find it. Then write a short note to bring and three questions to ask. Offer to save it and remind me the evening before, and do that only after I say yes.',
    icon: 'calendar',
    needs: ['calendar', 'email'],
  },
  school: {
    title: 'School and activities this week',
    detail: () => 'Pickups, forms, events and what to send in, by day',
    prompt:
      "I want to see this week's school and activities. Look at my calendar and email for the next seven days for anything about school, clubs or activities: pickups, forms, events and things to send in. List them by day and mark anything that needs an answer from me. Offer to do this every Sunday, and set it up only after I say yes.",
    icon: 'calendar',
    needs: ['calendar', 'email'],
  },
  chores: {
    title: 'Share the load at home',
    detail: () => 'Who does what this week, as a chart you can share',
    prompt:
      'I want to share the load at home. In one short message, ask me who lives here and which jobs need doing each week. Then make a fair weekly chart that rotates the jobs nobody likes and that I can share with the others. Offer to save it to a space and reshuffle it every month, and do that only after I say yes.',
    icon: 'broom',
  },
  hard_talk: {
    title: 'A hard conversation about care',
    detail: assistant => `${assistant} helps you find the words`,
    prompt:
      "I need to have a hard conversation about someone's care. In one short message, ask me who it is with and what I need from it. Then help me find a few short, honest and kind lines to open it, and one for if it goes badly. Offer to practice it with me first.",
    icon: 'message-square-text',
  },
  subscriptions: {
    title: 'What am I paying for every month?',
    detail: () => 'Subscriptions and renewals from your email, with what you may have forgotten',
    prompt:
      'I want to know what I am paying for every month. Look through my email from the last year for subscriptions, renewals and recurring charges, and give me a table of what I pay for, how much and how often, marking anything that looks forgotten or doubled. Then ask which ones I want to cancel and help me with those, showing me any message before it is sent and waiting for my OK.',
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
      'I think I may be overcharged. In one short message, ask me what the service is and what I pay. Then search for what people typically pay for the same thing and tell me whether mine looks high, about right or low, with a source. If it looks high, draft a short message asking for a better rate, show it to me, and wait for my OK before anything is sent.',
    icon: 'search',
  },
  money_due: {
    title: 'Money coming up',
    detail: () => 'Bills, renewals and payments due in the next month, by date',
    prompt:
      'I want to see the money coming up. Look at my email and calendar for bills, renewals and payments due in the next 30 days, and list them by date with the amount if you can see it, marking any that are overdue. Offer reminders two days before each and this list every month, and set them up only after I say yes.',
    icon: 'calendar-clock',
    needs: ['calendar', 'email'],
  },
  budget: {
    title: 'A simple budget for this month',
    detail: () => 'What comes in, goes out, and is left',
    prompt:
      'I want a simple budget for this month. In one short message, ask me what comes in this month and the fixed things that must go out; rounding is fine, and if I am not sure of a number, use a round guess and say it is a guess. Show me three numbers: what comes in, what must go out, and what is left, and ask if I want to set aside anything from what is left. Offer to save the budget and check in with me mid-month, and do that only after I say yes.',
    icon: 'chart',
  },
  sort_out: {
    title: 'What do I need to sort out first?',
    detail: () => 'Papers, bank, health care, housing',
    prompt:
      'I just moved here and I want to know what to sort out first. In one short message, ask me which country and city I live in and when I arrived; if I cannot give you one of these, carry on with what you have and say which part is missing. Then search official government pages and give me a checklist for this month covering papers and registration, bank, health care and housing, in the order to do them, with how to do each and a link to the official page, saying which items you could not confirm. Offer to save it and remind me of the next item each Monday, and do that only after I say yes.',
    icon: 'list-check',
  },
  letter: {
    title: 'Explain this letter',
    detail: assistant => `${assistant} says what it means and what to do`,
    prompt:
      'I will paste or describe a letter next. Tell me in plain words what it says, whether I need to act, and by when, and translate it for me if I need that. Ask before writing a reply.',
    icon: 'file',
  },
  doctor: {
    title: 'Find a doctor near me',
    detail: () => 'Nearby doctors taking new patients',
    prompt:
      'I need a doctor near me. In one short message, ask me where I live, unless you already know. Then search for three family doctors near there that take new patients, each with how long it takes to get there, opening hours and a link, and show them on a map. Tell me how to register with one, step by step, from the official health service page.',
    icon: 'map-pin',
    needs: ['maps'],
  },
  language: {
    title: 'Ten minutes of the language',
    detail: () => 'Practice the pharmacy or the school office',
    prompt:
      'I want ten minutes of language practice. In one short message, ask me which language and what I need it for this week, like the pharmacy, the school office or the landlord. Then run a ten-minute practice where we take turns with short lines and you gently correct my mistakes after each turn. Offer to do ten minutes again tomorrow, and set that up only after I say yes.',
    icon: 'message-square-text',
  },
  locals_know: {
    title: 'What people here just know',
    detail: () => 'The everyday things nobody tells newcomers',
    prompt:
      "I just moved and I want to know what people here just know. In one short message, ask me which country and city, unless you already know. Then search recent advice from people who live there and tell me the five everyday things newcomers most often get wrong or don't know, with a link for each. At the end, offer the five for a specific situation next, like renting, schools or getting around.",
    icon: 'lightbulb',
  },
  neighborhood: {
    title: 'Choose a neighborhood',
    detail: () => "Three options compared on rent, commute and what it's like to live there",
    prompt:
      'I am choosing a neighborhood. In one short message, ask me the city, my budget, and where I will spend most of my days; if I skip one, use what you have and say what you assumed. Then search current rents and travel times and compare three neighborhoods for me: the rent with a source, the commute time, and what living there is like. Offer to show them on a map.',
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

/** Runs the person's own daily brief schedule now, so the run uses the task they wrote, home address and all. */
export const RUN_BRIEF_CARD: TourCardFace = {
  title: 'Run my daily brief',
  detail: () => 'Runs your scheduled brief now',
  icon: 'play',
};

/** One place on the home grid: an example that fills the composer, or the card that runs the brief schedule. */
export type HomeSlot = { kind: 'prompt'; card: TourCard } | { kind: 'run_brief'; card: TourCardFace };

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

/**
 * The home's cards. With a brief schedule to run, the run card shows with no pill chosen and under
 * "I'm behind": just after the morning brief card, or first when that card is not shown. The count stays the same.
 */
export function homeSlotsFor({
  topic,
  capabilities,
  briefRun,
}: {
  topic: HomeTopicId | null;
  capabilities: TourCapabilities;
  briefRun: boolean;
}): HomeSlot[] {
  const prompts = homeCardsFor({ topic, capabilities }).map((card): HomeSlot => ({ kind: 'prompt', card }));
  if (!briefRun || (topic !== null && topic !== 'behind')) return prompts;
  const at = prompts.findIndex(slot => slot.card === CARDS.brief) + 1;
  const runBrief: HomeSlot = { kind: 'run_brief', card: RUN_BRIEF_CARD };
  return [...prompts.slice(0, at), runBrief, ...prompts.slice(at)].slice(0, HOME_CARD_COUNT);
}

/** The pill each help area chosen in setup leads to; the one table that ties profile choices to the home. */
export const HELP_AREA_TOPIC: Record<HelpAreaId, HomeTopicId> = {
  focus: 'help_me_think',
  family: 'someone_i_look_after',
  caring: 'someone_i_look_after',
  new_country: 'just_moved',
  work_money: 'money',
};
