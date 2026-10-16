import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import type { PersonalizationProfileContent } from '../../personalization/profile';
import { ScheduleManifestSchema } from '../../schemas/schedule';
import { dayLabels, isoDay, type CalendarDay, type DayLabels } from './calendar';
import { photographyGuide, relocationGuide } from './maya/knowledge';
import { mayaMemoryNotes } from './maya/memories';
import { junePersona, PDF_GUIDANCE, theoPersona, WORKSPACE_GUIDANCE } from './maya/personas';
import { BACKUP_CLINIC, GP_CLINIC, HOME, VISA_CLINIC } from './maya/places';
import { tasksSpaceBody } from './maya/tasks';
import type { DemoBriefing, DemoNote, DemoSpace, DemoWorld } from './model';
import { encodePolyline, type LatLng } from './polyline';

/** Provenance stamped on every seeded record; reset removes exactly the records that carry it. */
export const DEMO_MARKER = 'demo_synthetic';

/** Persona ids, space ids and schedule/agent names that start with this are seeded; the ids are free-form strings. */
export const DEMO_ID_PREFIX = 'demo-synthetic';
export const DEMO_JUNE_ID = `${DEMO_ID_PREFIX}-persona-june`;
export const DEMO_THEO_ID = `${DEMO_ID_PREFIX}-persona-theo`;
export const DEMO_AGENT_NAME = `${DEMO_ID_PREFIX}-assistant`;
/** Resource names are lowercase and hyphenated, so the Schedules page lists this as "morning-brief". */
export const DEMO_SCHEDULE_NAME = 'morning-brief';
export const DEMO_TASKS_SPACE_ID = `${DEMO_ID_PREFIX}-tasks`;

export const DEFAULT_DEMO_USER = 'judge@example.com';
/** Maya lives in Lisbon, so "today" is Lisbon's today unless the caller names a day. */
export const DEFAULT_DEMO_TIME_ZONE = 'Europe/Lisbon';

/** The walk from Maya's rental to the GP clinic, the pre-baked chat's route. */
const FROM_POINT: LatLng = { lat: 38.7105, lng: -9.1445 };
const TO_POINT: LatLng = { lat: 38.714655, lng: -9.153937 };
const ROUTE_WAYPOINTS: readonly LatLng[] = [
  FROM_POINT,
  { lat: 38.711, lng: -9.1475 },
  { lat: 38.7125, lng: -9.1505 },
  { lat: 38.7138, lng: -9.1525 },
  TO_POINT,
];
const ROUTE_DISTANCE_KM = 1.6;
/** The route tool reports a road route, so the brief gives the walking time itself. */
const ROUTE_DURATION_MIN = 5;
const WALK_MINUTES = 22;

export interface DemoWorldInput {
  /** "Today" in the user's zone: every date in the world is an offset from this day. */
  today: CalendarDay;
  timeZone: string;
  /** Fully qualified `provider/model` for the personas and the briefing agent. */
  modelName: string;
}

function buildSpaces(days: DayLabels): DemoSpace[] {
  return [
    {
      id: DEMO_TASKS_SPACE_ID,
      content: {
        name: 'Tasks',
        purpose: "Maya's task list: what is open, what is in progress and what is done.",
        status: 'active',
        format: 'markdown',
        body: tasksSpaceBody(days),
      },
    },
  ];
}

function buildNotes(days: DayLabels): DemoNote[] {
  return [
    ...mayaMemoryNotes(days),
    {
      key: 'gp-search',
      body: `Maya needs a regular English-speaking GP. Shortlist: ${GP_CLINIC.name} (${GP_CLINIC.address}, open ${GP_CLINIC.hours}) is the first choice and ${BACKUP_CLINIC.name} (${BACKUP_CLINIC.address}) the backup. ${VISA_CLINIC.name} is already booked for her visa medical, so do not suggest it as a GP.`,
    },
  ];
}

function buildBriefing(): DemoBriefing {
  return {
    title: 'From home to the GP',
    userText: `How far is it from home to ${GP_CLINIC.name}? I would like to walk.`,
    routeIntro: 'Let me map the walk to the clinic.',
    routeArguments: { from_place: HOME.address, to_place: GP_CLINIC.address },
    routeResult: {
      from: { resolved_name: `${HOME.address}, Portugal`, ...FROM_POINT },
      to: { resolved_name: `${GP_CLINIC.address}, Portugal`, ...TO_POINT },
      distance_km: ROUTE_DISTANCE_KM,
      duration_min: ROUTE_DURATION_MIN,
      route_geometry: encodePolyline(ROUTE_WAYPOINTS),
      attribution: '© OpenStreetMap contributors',
    },
    finalText: [
      `${GP_CLINIC.name} is about ${String(ROUTE_DISTANCE_KM)} km from your place in ${HOME.area}, roughly a ${String(WALK_MINUTES)}-minute walk with some uphill, so take it slowly given your asthma.`,
      '',
      `- It is open ${GP_CLINIC.hours}.`,
      '- Your first appointment is already booked. Mention your penicillin allergy when you arrive.',
    ].join('\n'),
  };
}

/** Everything the seed writes, derived from "today" in the user's zone so the dates stay relative. */
export function buildDemoWorld(input: DemoWorldInput): DemoWorld {
  const days = dayLabels(input.today);

  const profile: PersonalizationProfileContent = {
    assistant_name: null,
    assistant_identity: null,
    voice_guidance: 'Warm, plain and brief.',
    user_profile: `Maya, a fictional demo user (${DEMO_MARKER}). A 38-year-old UX designer who moved from Austin to Lisbon, shoots street photography, and is learning Portuguese.`,
    pinned_preferences: [
      'Keep answers short and warm.',
      'Always mention the penicillin allergy when a doctor comes up.',
    ],
    learned_profile: null,
    learning_enabled: false,
  };

  return {
    day: isoDay(input.today),
    personas: [
      { id: DEMO_JUNE_ID, content: junePersona(input.modelName), knowledge: relocationGuide() },
      { id: DEMO_THEO_ID, content: theoPersona(input.modelName), knowledge: photographyGuide() },
    ],
    profile,
    notes: buildNotes(days),
    spaces: buildSpaces(days),
    agentDescription: `Synthetic demo assistant (${DEMO_MARKER}).`,
    agentSpec: AgentSpecSchema.parse({
      model: { name: input.modelName },
      config: { sandbox: { enabled: true } },
      instructions: [
        'You are Aman, a calm personal assistant for Maya, a fictional demo user who just moved from Austin to Lisbon.',
        'Use what you remember about her. Keep answers short and warm.',
        WORKSPACE_GUIDANCE,
        PDF_GUIDANCE,
      ].join(' '),
    }),
    scheduleManifest: ScheduleManifestSchema.parse({
      task: [
        'Good morning. Read my calendar for today and my inbox.',
        'Summarise what needs my attention: what is on today, what I need to prepare, and which emails are waiting on me.',
        `Flag upcoming appointments and what to bring. Work out travel from my place, ${HOME.address}, unless I say otherwise.`,
        'Draft a reply for anything that needs one, but do not send anything. Leave every send for me to approve under Needs your OK.',
      ].join(' '),
      cron: '30 7 * * *',
      timezone: input.timeZone,
      status: 'active',
    }),
    briefing: buildBriefing(),
  };
}
