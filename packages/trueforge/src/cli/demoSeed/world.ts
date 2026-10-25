import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { MORNING_BRIEF_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
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
/** Resource names are lowercase and hyphenated, so the Schedules page lists this as "morning-brief". */
export const DEMO_SCHEDULE_NAME = 'morning-brief';
export const DEMO_TASKS_SPACE_ID = `${DEMO_ID_PREFIX}-tasks`;

/** How reset tells the seeded profile from one the person wrote: the assistant reads it, so it carries no marker. */
export const DEMO_USER_PROFILE =
  'Maya is a 38-year-old UX designer who moved from Austin to Lisbon, shoots street photography, and is learning Portuguese.';

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
    assistant_name: null,
    assistant_identity: null,
    voice_guidance: 'Warm, plain and brief.',
    user_name: 'Maya',
    address_as: 'Maya',
    user_profile: DEMO_USER_PROFILE,
    pinned_preferences: [
      'Keep answers short and warm.',
      'Always mention the penicillin allergy when a doctor comes up.',
    ],
    help_areas: ['new_country', 'work_money'],
    learned_profile: null,
    learning_enabled: false,
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
      config: { sandbox: { enabled: true } },
      instructions: [
        'You are a calm personal assistant for Maya, who just moved from Austin to Lisbon.',
        'Use what you remember about her. Keep answers short and warm.',
        WORKSPACE_GUIDANCE,
        PDF_GUIDANCE,
      ].join(' '),
    }),
    scheduleManifest: ScheduleManifestSchema.parse({
      task: [
        MORNING_BRIEF_PROMPT,
        `Work out travel from my place, ${HOME.address}, unless I say otherwise.`,
        'For any email that needs a reply, write a short suggested reply in the brief. Do not send or save anything.',
      ].join(' '),
      cron: '30 7 * * *',
      timezone: input.timeZone,
      status: 'active',
    }),
  };
}
