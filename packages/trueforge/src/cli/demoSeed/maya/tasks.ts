import type { CalendarDay } from '@truefoundry/trueforge-core/core/util/calendarDay';
import { dayLabels, STORY, weekdayOffset, type DayLabels } from '../storyDays.mjs';
import { CAMERA_SHOP, GP_CLINIC, VISA_CLINIC } from './places';

type TaskState = 'done' | 'in_progress' | 'open';

/** One task; offsets count days from today, so its dates match her mail and calendar. */
interface MayaTask {
  title: string;
  state: TaskState;
  /** Days from today on which the task was finished; set only for a done task. */
  doneOffset: number | null;
  dueOffset: number | null;
  notes: string | null;
}

function mayaTasks({ days, today }: { days: DayLabels; today: CalendarDay }): readonly MayaTask[] {
  const gpVisit = weekdayOffset({ today, offset: STORY.GP_VISIT_EARLIEST });
  return [
    {
      title: 'Book flight to Lisbon',
      state: 'done',
      doneOffset: STORY.TASK_FLIGHT_DONE,
      dueOffset: null,
      notes: null,
    },
    {
      title: 'Get NIF (tax number)',
      state: 'done',
      doneOffset: STORY.TASK_NIF_DONE,
      dueOffset: null,
      notes: 'Issued via Sofia Almeida. Document saved.',
    },
    {
      title: 'Open Portuguese bank account',
      state: 'done',
      doneOffset: STORY.TASK_BANK_DONE,
      dueOffset: null,
      notes: null,
    },
    { title: 'Register with AIMA', state: 'done', doneOffset: STORY.TASK_AIMA_DONE, dueOffset: null, notes: null },
    {
      title: 'Find short-term rental for first month',
      state: 'done',
      doneOffset: STORY.TASK_RENTAL_DONE,
      dueOffset: null,
      notes: null,
    },
    {
      title: 'Find English-speaking GP',
      state: 'in_progress',
      doneOffset: null,
      dueOffset: null,
      notes: `GP appointment ${days.longYear(gpVisit)}, 09:30 at ${GP_CLINIC.name} with Dra. Helena Rocha (confirmation email in the inbox). Mention the penicillin allergy.`,
    },
    {
      title: 'Complete visa medical',
      state: 'in_progress',
      doneOffset: null,
      dueOffset: STORY.VISA_VISIT,
      notes: `Appointment ${days.monthDay(STORY.VISA_VISIT)}, 10:00 at ${VISA_CLINIC.name}. Bring passport, NIF, insurance card, medication list, allergy note.`,
    },
    {
      title: 'Tour apartments',
      state: 'in_progress',
      doneOffset: null,
      dueOffset: STORY.TOUR_SECOND_DAY,
      notes: `Two viewings ${days.monthDay(STORY.TOUR_FIRST_DAY)} (Alfama 11:00, Graça 15:30), two more ${days.monthDay(STORY.TOUR_SECOND_DAY)} (Mouraria 11:30, Campo de Ourique 16:00).`,
    },
    {
      title: 'Decide on long-term neighborhood',
      state: 'open',
      doneOffset: null,
      dueOffset: STORY.NEIGHBORHOOD_DECISION,
      notes:
        'Shortlist: Alfama (charm, steep), Graça (views, steep, no metro), Mouraria (multicultural, fado), Campo de Ourique (residential, market, flatter).',
    },
    {
      title: 'Pick up the 35mm-equivalent camera lens',
      state: 'open',
      doneOffset: null,
      dueOffset: STORY.CAMERA_PICKUP,
      notes: `Order ${CAMERA_SHOP.orderNumber} ready for pickup at ${CAMERA_SHOP.name}. Fujifilm XF 23mm f/2. Collect it before the first photo session.`,
    },
    {
      title: 'Start Portuguese classes',
      state: 'in_progress',
      doneOffset: null,
      dueOffset: null,
      notes: 'A1 beginner, week 3. Homework: describe your neighborhood in Portuguese.',
    },
    {
      title: "Plan 'Old Lisbon' photo series",
      state: 'open',
      doneOffset: null,
      dueOffset: null,
      notes: `Sessions: ${days.monthDay(STORY.ALFAMA_SESSION)} Alfama sunrise, ${days.monthDay(STORY.GRACA_SESSION)} Miradouro da Graça golden hour, ${days.monthDay(STORY.BELEM_SESSION)} Belém golden hour.`,
    },
  ];
}

function taskLine({ task, days }: { task: MayaTask; days: DayLabels }): string {
  const box = task.state === 'done' ? '[x]' : '[ ]';
  const status = task.state === 'in_progress' ? ' (in progress)' : '';
  const due = task.dueOffset === null ? '' : ` - due ${days.long(task.dueOffset)}`;
  const done = task.doneOffset === null ? '' : ` - done ${days.long(task.doneOffset)}`;
  return `- ${box} ${task.title}${status}${due}${done}${task.notes === null ? '' : `\n  ${task.notes}`}`;
}

/** The Tasks space for `today`: open work first, then what is finished. */
export function tasksSpaceBody(today: CalendarDay): string {
  const days = dayLabels(today);
  const tasks = mayaTasks({ days, today });
  const lines = (done: boolean): string[] =>
    tasks.filter(task => (task.state === 'done') === done).map(task => taskLine({ task, days }));
  return [
    "Maya's tasks. Keep this list current: tick a task when it is done and add what changes.",
    '',
    '## Open',
    ...lines(false),
    '',
    '## Done',
    ...lines(true),
  ].join('\n');
}
