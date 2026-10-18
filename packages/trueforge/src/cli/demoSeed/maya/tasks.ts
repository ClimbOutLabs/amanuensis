import { addDays, isoDay, type CalendarDay } from '@truefoundry/trueforge-core/core/util/calendarDay';
import { MAYA_DAYS, MAYA_MAILBOX_DAY } from './days';
import { CAMERA_SHOP, GP_CLINIC, VISA_CLINIC } from './places';

type TaskState = 'done' | 'in_progress' | 'open';

/** One task; offsets count days from the mailbox day, so its dates match her mail and calendar. */
interface MayaTask {
  title: string;
  state: TaskState;
  /** Days from the mailbox day on which the task was finished; set only for a done task. */
  doneOffset: number | null;
  dueOffset: number | null;
  /** The booked appointment that finishes the task: once the seed day is past it, the task shows as done. */
  appointmentOffset: number | null;
  notes: string | null;
}

const MAYA_TASKS: readonly MayaTask[] = [
  {
    title: 'Book flight to Lisbon',
    state: 'done',
    doneOffset: -17,
    dueOffset: null,
    appointmentOffset: null,
    notes: null,
  },
  {
    title: 'Get NIF (tax number)',
    state: 'done',
    doneOffset: -8,
    dueOffset: null,
    appointmentOffset: null,
    notes: 'Issued via Sofia Almeida. Document saved.',
  },
  {
    title: 'Open Portuguese bank account',
    state: 'done',
    doneOffset: -6,
    dueOffset: null,
    appointmentOffset: null,
    notes: null,
  },
  { title: 'Register with AIMA', state: 'done', doneOffset: -4, dueOffset: null, appointmentOffset: null, notes: null },
  {
    title: 'Find short-term rental for first month',
    state: 'done',
    doneOffset: -16,
    dueOffset: null,
    appointmentOffset: null,
    notes: null,
  },
  {
    title: 'Find English-speaking GP',
    state: 'in_progress',
    doneOffset: null,
    dueOffset: null,
    appointmentOffset: 3,
    notes: `GP appointment ${MAYA_DAYS.long(3)}, 2026, 09:30 at ${GP_CLINIC.name} with Dra. Helena Rocha (confirmation email in the inbox). Mention the penicillin allergy.`,
  },
  {
    title: 'Complete visa medical',
    state: 'in_progress',
    doneOffset: null,
    dueOffset: 2,
    appointmentOffset: 2,
    notes: `Appointment ${MAYA_DAYS.monthDay(2)}, 10:00 at ${VISA_CLINIC.name}. Bring passport, NIF, insurance card, medication list, allergy note.`,
  },
  {
    title: 'Tour apartments',
    state: 'in_progress',
    doneOffset: null,
    dueOffset: 3,
    appointmentOffset: null,
    notes: `Two viewings ${MAYA_DAYS.monthDay(1)} (Alfama 11:00, Graça 15:30), two more ${MAYA_DAYS.monthDay(3)} (Mouraria 11:30, Campo de Ourique 16:00).`,
  },
  {
    title: 'Decide on long-term neighborhood',
    state: 'open',
    doneOffset: null,
    dueOffset: 11,
    appointmentOffset: null,
    notes:
      'Shortlist: Alfama (charm, steep), Graça (views, steep, no metro), Mouraria (multicultural, fado), Campo de Ourique (residential, market, flatter).',
  },
  {
    title: 'Pick up the 35mm-equivalent camera lens',
    state: 'open',
    doneOffset: null,
    dueOffset: 3,
    appointmentOffset: null,
    notes: `Order ${CAMERA_SHOP.orderNumber} ready for pickup at ${CAMERA_SHOP.name}. Fujifilm XF 23mm f/2. Collect it before the first photo session.`,
  },
  {
    title: 'Start Portuguese classes',
    state: 'in_progress',
    doneOffset: null,
    dueOffset: null,
    appointmentOffset: null,
    notes: 'A1 beginner, week 3. Homework: describe your neighborhood in Portuguese.',
  },
  {
    title: "Plan 'Old Lisbon' photo series",
    state: 'open',
    doneOffset: null,
    dueOffset: null,
    appointmentOffset: null,
    notes: `Sessions: ${MAYA_DAYS.monthDay(4)} Alfama sunrise, ${MAYA_DAYS.monthDay(5)} Miradouro da Graça golden hour, ${MAYA_DAYS.monthDay(12)} Belém golden hour.`,
  },
];

function asOf({ task, seedDay }: { task: MayaTask; seedDay: CalendarDay }): MayaTask {
  const offset = task.appointmentOffset;
  if (offset === null || isoDay(seedDay) <= isoDay(addDays({ day: MAYA_MAILBOX_DAY, days: offset }))) {
    return task;
  }
  return { ...task, state: 'done', doneOffset: offset, dueOffset: null };
}

function taskLine(task: MayaTask): string {
  const box = task.state === 'done' ? '[x]' : '[ ]';
  const status = task.state === 'in_progress' ? ' (in progress)' : '';
  const due = task.dueOffset === null ? '' : ` - due ${MAYA_DAYS.long(task.dueOffset)}`;
  const done = task.doneOffset === null ? '' : ` - done ${MAYA_DAYS.long(task.doneOffset)}`;
  return `- ${box} ${task.title}${status}${due}${done}${task.notes === null ? '' : `\n  ${task.notes}`}`;
}

/** The Tasks space as of the seed day: open work first, then what is finished. */
export function tasksSpaceBody(seedDay: CalendarDay): string {
  const tasks = MAYA_TASKS.map(task => asOf({ task, seedDay }));
  const lines = (done: boolean): string[] => tasks.filter(task => (task.state === 'done') === done).map(taskLine);
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
