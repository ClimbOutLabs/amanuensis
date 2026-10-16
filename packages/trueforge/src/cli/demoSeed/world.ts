import { AgentSpecSchema, type AgentSpec } from '@truefoundry/trueforge-core/agent-session';
import type { PersonalizationProfileContent } from '../../personalization/profile';
import type { PersonaContent } from '../../personas/persona';
import { ScheduleManifestSchema, type ScheduleManifest } from '../../schemas/schedule';
import { addDays, clockLabel, dayInZone, isoDay, longDayLabel, weekdayOf, type CalendarDay } from './calendar';
import { encodePolyline, type LatLng } from './polyline';

/** Provenance stamped on every seeded record; reset removes exactly the records that carry it. */
export const DEMO_MARKER = 'demo_synthetic';

/** Persona ids and schedule/agent names that start with this are seeded; the ids are free-form strings. */
export const DEMO_ID_PREFIX = 'demo-synthetic';
export const DEMO_PERSONA_ID = `${DEMO_ID_PREFIX}-persona`;
export const DEMO_AGENT_NAME = `${DEMO_ID_PREFIX}-assistant`;
export const DEMO_SCHEDULE_NAME = `${DEMO_ID_PREFIX}-morning-briefing`;

export const DEFAULT_DEMO_USER = 'judge@example.com';
/** The fictional user lives in Barcelona, so "today" is Barcelona's today unless overridden. */
export const DEFAULT_DEMO_TIME_ZONE = 'Europe/Madrid';

const APPOINTMENT_HOUR = 16;
const EARLY_MINUTES = 15;
const CUSHION_MINUTES = 10;

const FROM_PLACE = 'Poblenou, Barcelona';
const TO_PLACE = 'Hospital Clinic, Barcelona';
const FROM_POINT: LatLng = { lat: 41.4033, lng: 2.2022 };
const TO_POINT: LatLng = { lat: 41.3893, lng: 2.1511 };
const ROUTE_WAYPOINTS: readonly LatLng[] = [
  FROM_POINT,
  { lat: 41.3991, lng: 2.1852 },
  { lat: 41.3944, lng: 2.1694 },
  { lat: 41.3912, lng: 2.1583 },
  TO_POINT,
];
const ROUTE_DISTANCE_KM = 5.6;
const ROUTE_DURATION_MIN = 16;

export interface DemoNote {
  key: string;
  body: string;
}

/** What the pre-baked briefing chat shows, in the order the turn runs. */
export interface DemoBriefing {
  title: string;
  userText: string;
  routeArguments: { from_place: string; to_place: string };
  routeResult: {
    from: { resolved_name: string; lat: number; lng: number };
    to: { resolved_name: string; lat: number; lng: number };
    distance_km: number;
    duration_min: number;
    route_geometry: string;
    attribution: string;
  };
  finalText: string;
}

export interface DemoWorld {
  /** The seeded day (`YYYY-MM-DD` in the user's zone); a changed day means the dated content is stale. */
  day: string;
  persona: PersonaContent;
  profile: PersonalizationProfileContent;
  notes: DemoNote[];
  agentDescription: string;
  agentSpec: AgentSpec;
  scheduleManifest: ScheduleManifest;
  briefing: DemoBriefing;
}

export interface DemoWorldInput {
  now: Date;
  timeZone: string;
  /** Fully qualified `provider/model` for the persona and the briefing agent. */
  modelName: string;
}

function minutesLabel(totalMinutes: number): string {
  return clockLabel({ hour: Math.floor(totalMinutes / 60), minute: totalMinutes % 60 });
}

const SATURDAY = 6;

/** Day offsets for the week's errands: the next three working days, then the coming Saturday and the Sunday after. */
function weekPlan(today: CalendarDay): { library: number; sync: number; bill: number; pot: number; call: number } {
  const ahead = Array.from({ length: 14 }, (_, index) => index + 1);
  const isWorkday = (offset: number): boolean => {
    const weekday = weekdayOf(addDays({ day: today, days: offset }));
    return weekday !== 0 && weekday !== SATURDAY;
  };
  const [library = 1, sync = 2, bill = 3] = ahead.filter(isWorkday);
  const pot = ahead.find(offset => weekdayOf(addDays({ day: today, days: offset })) === SATURDAY) ?? 6;
  return { library, sync, bill, pot, call: pot + 1 };
}

/** The seed does not guess which sandbox backend exists; the app reports an unavailable sandbox itself. */
const PDF_GUIDANCE =
  'When she asks for a PDF or a file, build it with run_code and say where to download it. If run_code is not available, say so plainly and give the checklist as plain text she can print.';

/** Everything the seed writes, derived from "today" in the user's zone so the dates stay relative. */
export function buildDemoWorld(input: DemoWorldInput): DemoWorld {
  const today = dayInZone({ now: input.now, timeZone: input.timeZone });
  const label = (offset: number): string => longDayLabel(addDays({ day: today, days: offset }));
  const todayLabel = label(0);
  const plan = weekPlan(today);

  const appointmentMinutes = APPOINTMENT_HOUR * 60;
  const latestLeave = appointmentMinutes - EARLY_MINUTES - ROUTE_DURATION_MIN;
  const leaveBy = Math.floor((latestLeave - CUSHION_MINUTES) / 5) * 5;
  const appointmentLabel = minutesLabel(appointmentMinutes);
  const leaveLabel = minutesLabel(leaveBy);

  const notes: DemoNote[] = [
    {
      key: 'style',
      body: 'Mara prefers short, friendly answers. She leaves 15 minutes early for anything medical.',
    },
    {
      key: 'travel',
      body: 'Mara usually gets around Barcelona by metro and taxi, not by car. Her insurance card lives in the blue wallet.',
    },
    {
      key: 'home-area',
      body: "Mara's home area is Gràcia, Barcelona. Only the neighborhood is noted, never a street address.",
    },
    {
      key: 'work-area',
      body: "Mara's work area is Poblenou, Barcelona, where her team has a shared office. Only the neighborhood is noted, never a street address.",
    },
    {
      key: 'appointment-today',
      body:
        `Appointment today, ${todayLabel}, at ${appointmentLabel}: check-up with Dr. Halloran, her GP, at ${TO_PLACE}. ` +
        'Bring the referral letter from the orthopedics department and the insurance card from the blue wallet. ' +
        `Today Mara is working from the Poblenou office, so she would head to the clinic from there. ` +
        'Her friend Teo Marsh (teo.marsh@example.com) suggested coffee after the appointment.',
    },
    {
      key: 'project-balcony',
      body: `Project: balcony herb garden. The basil and mint are doing well. Next step is a larger pot for the basil, planned for ${label(plan.pot)}.`,
    },
    {
      key: 'project-lisbon',
      body: 'Project: a Lisbon weekend with Teo Marsh in mid-November. Flights are not booked yet; Mara wants to agree dates first.',
    },
    {
      key: 'week-overview',
      body: [
        `What is on Mara's plate this week, starting ${todayLabel}:`,
        `- ${todayLabel}: ${appointmentLabel} appointment with Dr. Halloran at ${TO_PLACE}.`,
        ...[
          { offset: plan.library, text: 'return the library books.' },
          { offset: plan.sync, text: 'team sync at 10:00 in the Poblenou office.' },
          { offset: plan.bill, text: 'pay the quarterly utility bill.' },
          { offset: plan.pot, text: 'buy a larger pot for the basil.' },
          { offset: plan.call, text: 'call Teo about the Lisbon dates.' },
        ]
          .sort((a, b) => a.offset - b.offset)
          .map(item => `- ${label(item.offset)}: ${item.text}`),
      ].join('\n'),
    },
  ];

  const agentSpec = AgentSpecSchema.parse({
    model: { name: input.modelName },
    config: { sandbox: { enabled: true } },
    instructions: [
      'You are Aman, a calm personal assistant for Mara Hollis, a fictional demo user.',
      'Use what you remember about her. Keep answers short and friendly.',
      'For an appointment brief: recall the appointment, use render_route from where she starts to the appointment place, then give a short brief with when to leave and what to bring.',
      PDF_GUIDANCE,
    ].join(' '),
  });

  const route = {
    from: { resolved_name: 'Poblenou, Barcelona, Catalonia, Spain', ...FROM_POINT },
    to: { resolved_name: 'Hospital Clínic de Barcelona, Barcelona, Catalonia, Spain', ...TO_POINT },
    distance_km: ROUTE_DISTANCE_KM,
    duration_min: ROUTE_DURATION_MIN,
    route_geometry: encodePolyline(ROUTE_WAYPOINTS),
    attribution: '© OpenStreetMap contributors',
  };

  return {
    day: isoDay(today),
    persona: {
      display_name: 'Sol',
      aliases: ['Planner'],
      instructions: [
        'Sol is a calm planner who helps Mara Hollis, a fictional demo user, with appointments, errands and weekly planning.',
        'Be brief and friendly. Use what you remember about her before asking.',
        PDF_GUIDANCE,
      ].join(' '),
      model_name: input.modelName,
    },
    profile: {
      assistant_name: null,
      assistant_identity: null,
      voice_guidance: 'Warm, plain and brief.',
      user_name: 'Mara Hollis',
      address_as: 'Mara',
      user_profile: `Mara Hollis, a fictional demo user (${DEMO_MARKER}). Lives in Gràcia, Barcelona and works in Poblenou.`,
      pinned_preferences: ['Keep answers short and friendly.', 'Leave 15 minutes early for anything medical.'],
      learned_profile: null,
      learning_enabled: false,
    },
    notes,
    agentDescription: `Synthetic demo assistant (${DEMO_MARKER}).`,
    agentSpec,
    scheduleManifest: ScheduleManifestSchema.parse({
      task: 'Good morning. Check my memory for anything happening today. If there is an appointment, map the route to it and give me a short brief: when to leave, how to get there and what to bring.',
      cron: '30 7 * * *',
      timezone: input.timeZone,
      status: 'active',
    }),
    briefing: {
      title: 'Brief me before my 4 pm appointment',
      userText: 'Brief me before my 4 pm appointment.',
      routeArguments: { from_place: FROM_PLACE, to_place: TO_PLACE },
      routeResult: route,
      finalText: [
        `Your appointment is today at ${appointmentLabel} with Dr. Halloran at Hospital Clínic.`,
        '',
        `- Leave by ${leaveLabel} from Poblenou. By road it is about ${String(ROUTE_DURATION_MIN)} minutes (${String(ROUTE_DISTANCE_KM)} km), so a taxi gets you there early, as you like for anything medical.`,
        '- Bring the referral letter from the orthopedics department and your insurance card from the blue wallet.',
        '- Teo suggested coffee after, if you have time.',
      ].join('\n'),
    },
  };
}
