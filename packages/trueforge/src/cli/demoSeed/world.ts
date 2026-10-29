import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { isoDay, type CalendarDay } from '@truefoundry/trueforge-core/core/util/calendarDay';
import type { PersonalizationProfileContent } from '../../personalization/profile';
import { ScheduleManifestSchema } from '../../schemas/schedule';
import { photographyGuide, relocationGuide } from './maya/knowledge';
import { mayaMemoryNotes } from './maya/memories';
import { junePersona, PDF_GUIDANCE, theoPersona, WORKSPACE_GUIDANCE } from './maya/personas';
import { BACKUP_CLINIC, GP_CLINIC, HOME, VISA_CLINIC } from './maya/places';
import { tasksSpaceBody } from './maya/tasks';
import type { DemoNote, DemoSpace, DemoWorld } from './model';

/**
 * Provenance stamped on seeded memory notes and library documents; reset removes exactly the records that carry
 * it. The assistant reads it, so it is a plain name that says nothing about the data being made up.
 */
export const DEMO_MARKER = 'maya';

/** Persona ids, space ids and the agent name that start with this are seeded; ids people create are bare ULIDs. */
export const DEMO_ID_PREFIX = 'maya';
export const DEMO_JUNE_ID = `${DEMO_ID_PREFIX}-persona-june`;
export const DEMO_THEO_ID = `${DEMO_ID_PREFIX}-persona-theo`;
export const DEMO_AGENT_NAME = `${DEMO_ID_PREFIX}-assistant`;
export const DEMO_TASKS_SPACE_ID = `${DEMO_ID_PREFIX}-tasks`;

/** The demo schedule's task, in the owner's own words; the demo does not use the product's morning brief prompt. */
export const DEMO_BRIEF_TASK = `Run the Morning Brief as a Personal Intelligence Briefing, an OpenUI dashboard, adaptive, never a text dump. Do this, in order:
1. EMAIL: check what came in since yesterday's brief (inbox). List what needs me, most important first, one line each: who, what they want, and by when. Check all email. Compare with memory to see if you can help Maya in any way.
2. DRAFT REPLIES: for each email that needs an answer, write a draft reply in my voice and show it in the chat. Do not create email drafts in the mailbox. Do not send anything. Tell me which responses have been drafted in chat.
3. APPOINTMENTS I TRAVEL TO: for each event with an address, tell me when to leave, how long it takes and the best way to get there (driving, transit or walking), with a map. Add a buffer of 10 minutes.
4. BRIEFING FOR EACH APPOINTMENT: who I'm meeting, what we last emailed about, anything I promised them, and anything in my memories about them or the topic. Give me 2 or 3 talking points, and anything I need to bring.
5. TOMORROW AT A GLANCE: anything early tomorrow I should prepare for today.

Do not add opinions from personas or anyone else.
Never send email or change my calendar during the brief. Do not create or change spaces during the brief; the reply is the dashboard. If something on the calendar needs changing, put it on my "Needs your OK" list.

PERSONAL INTELLIGENCE:
- Research is allowed to deepen external facts (people, organizations, events, topics). Keep searches neutral and public, never personal. Personal detail comes only from what I know about Maya (memory/profile), never from a search.
- Weave what I know about Maya into every briefing: her life context, relationships, plans, and preferences. Personal, not a reading list; specifics come from my knowledge, not seeded here.
- Be efficient, not truncated: cover what's useful richly, but no filler; each section tight, and the whole as short as possible while still genuinely useful.
- PRIVACY SPINE: the brief is private and can say anything. Drafts are in her voice, carry only recipient-relevant facts, and never send. Nothing escapes.
- Surface the single most important actionable item first, on its own highlighted card, never buried.

OUTPUT: write the dashboard in your reply as an openui block (read the OpenUI instructions first; there is no dashboard tool). Draw each route once. Sections: header, 📥 Email table, 📝 Drafts, 📅 Calendar, 🧭 Travel, 🎯 Briefing per appointment, 🔭 Tomorrow, ✅ Needs your OK, with color-coded priority badges and emoji markers. Adapt: drop empty sections, never render filler. Plain, direct words; no flowery filler; no em dashes. The reply holds only the dashboard: no notes about what you are doing or planning, no text before or after the block.`;

/** How reset tells the seeded profile from one the person wrote: the assistant reads it, so it carries no marker. */
export const DEMO_USER_PROFILE =
  'Maya is a 38-year-old UX designer who moved from Austin to Lisbon, shoots street photography, and is learning Portuguese.';

/** The character the demo assistant is given, in the owner's words. */
export const DEMO_ASSISTANT_IDENTITY = `Have opinions. You're allowed to disagree, prefer things, find stuff amusing or boring.

Come back with answers, not questions: try to figure it out or build it yourself before asking.

When looking for something, search wide before giving up: try different wordings, look further back, and open the likely messages and attachments. Say where you found it. Look up numbers (nutrition, money, schedules, specs) before stating them; "let me check" beats a confident wrong answer.

Be bold with internal work: reading, organizing, learning.

Use rich cards, tables, and dashboards for summaries, plans and comparisons; plain text otherwise.

Never preachy, never flowery.

Vibe
Best friend who knows where to look. Wants Maya to grow. Keeps her accountable with kindness. Never lies to make her feel better. Optimistic, pragmatic, growth-focused, supportive. Concise when needed, thorough when it matters. The friend who tells you the truth because they actually care about where you end up.`;

export const DEFAULT_DEMO_USER = 'judge@example.com';
/** Maya lives in Lisbon, so "today" is Lisbon's today unless the caller names a day. */
export const DEFAULT_DEMO_TIME_ZONE = 'Europe/Lisbon';

export interface DemoWorldInput {
  /** "Today" in the user's zone; every date in her world, and in her mail, is counted from it. */
  today: CalendarDay;
  timeZone: string;
  /** Fully qualified `provider/model` for the personas and the agent. */
  modelName: string;
}

function buildSpaces(today: CalendarDay): DemoSpace[] {
  return [
    {
      id: DEMO_TASKS_SPACE_ID,
      content: {
        name: 'Tasks',
        purpose: "Maya's task list: what is open, what is in progress and what is done.",
        status: 'active',
        format: 'markdown',
        body: tasksSpaceBody(today),
      },
    },
  ];
}

function buildNotes(today: CalendarDay): DemoNote[] {
  return [
    ...mayaMemoryNotes(today),
    {
      key: 'gp-search',
      body: `Maya needs a regular English-speaking GP. Shortlist: ${GP_CLINIC.name} (${GP_CLINIC.address}, open ${GP_CLINIC.hours}) is the first choice and ${BACKUP_CLINIC.name} (${BACKUP_CLINIC.address}) the backup. ${VISA_CLINIC.name} is already booked for her visa medical, so do not suggest it as a GP.`,
    },
  ];
}

/** Everything the seed writes for "today" in the user's zone. */
export function buildDemoWorld(input: DemoWorldInput): DemoWorld {
  const profile: PersonalizationProfileContent = {
    assistant_name: 'Nata',
    assistant_identity: DEMO_ASSISTANT_IDENTITY,
    voice_guidance: 'Warm, friendly, honest, direct and caring.',
    user_name: 'Maya',
    address_as: 'Maya',
    user_profile: DEMO_USER_PROFILE,
    pinned_preferences: [
      'Keep answers short and warm.',
      'Always mention the penicillin allergy when a doctor comes up.',
    ],
    help_areas: ['new_country', 'work_money'],
    learned_profile: null,
    learning_enabled: true,
  };

  return {
    day: isoDay(input.today),
    timeZone: input.timeZone,
    personas: [
      { id: DEMO_JUNE_ID, content: junePersona(input.modelName), knowledge: relocationGuide() },
      { id: DEMO_THEO_ID, content: theoPersona(input.modelName), knowledge: photographyGuide() },
    ],
    profile,
    notes: buildNotes(input.today),
    spaces: buildSpaces(input.today),
    agentDescription: "Maya's personal assistant.",
    agentSpec: AgentSpecSchema.parse({
      model: { name: input.modelName },
      // Her mailbox is small: the brief reads whole results instead of sandbox previews it would have to read back.
      config: { sandbox: { enabled: true }, context_management: { large_tool_response: { enabled: false } } },
      instructions: [
        'You are Nata, a calm personal assistant for Maya, who just moved from Austin to Lisbon.',
        'Use what you remember about her. Warm, friendly, honest, direct and caring.',
        'Do your planning in your private reasoning. Your reply holds only the answer for the person.',
        'If a tool fails or a service is not connected, say so plainly and stop there; never invent what it would have returned.',
        WORKSPACE_GUIDANCE,
        PDF_GUIDANCE,
      ].join(' '),
    }),
    scheduleManifest: ScheduleManifestSchema.parse({
      task: [DEMO_BRIEF_TASK, `Work out travel from my place, ${HOME.address}, unless I say otherwise.`].join(' '),
      cron: '30 7 * * *',
      timezone: input.timeZone,
      status: 'active',
    }),
  };
}
