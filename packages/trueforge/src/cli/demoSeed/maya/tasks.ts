import type { DayLabels } from '../calendar';
import { CAMERA_SHOP, GP_CLINIC, VISA_CLINIC } from './places';

type TaskState = 'done' | 'in_progress' | 'open';

/** One task; offsets count days from the seed day, so a task is always as old and as due as it was in the story. */
interface MayaTask {
  title: string;
  state: TaskState;
  /** Days from the seed day on which the task was finished; set only for a done task. */
  doneOffset: number | null;
  dueOffset: number | null;
  notes: (days: DayLabels) => string | null;
}

const NO_NOTES = (): null => null;

const MAYA_TASKS: readonly MayaTask[] = [
  { title: 'Book flight to Lisbon', state: 'done', doneOffset: -17, dueOffset: null, notes: NO_NOTES },
  {
    title: 'Get NIF (tax number)',
    state: 'done',
    doneOffset: -8,
    dueOffset: null,
    notes: () => 'Issued via Sofia Almeida. Document saved.',
  },
  { title: 'Open Portuguese bank account', state: 'done', doneOffset: -6, dueOffset: null, notes: NO_NOTES },
  { title: 'Register with AIMA', state: 'done', doneOffset: -4, dueOffset: null, notes: NO_NOTES },
  { title: 'Find short-term rental for first month', state: 'done', doneOffset: -16, dueOffset: null, notes: NO_NOTES },
  {
    title: 'Find English-speaking GP',
    state: 'in_progress',
    doneOffset: null,
    dueOffset: 4,
    notes: () =>
      `${GP_CLINIC.name} is the first choice (English-speaking GPs, 2-3 day wait). Booking needs her preferred days and a phone number.`,
  },
  {
    title: 'Complete visa medical',
    state: 'in_progress',
    doneOffset: null,
    dueOffset: 2,
    notes: days =>
      `Appointment ${days.monthDay(2)}, 10:00 at ${VISA_CLINIC.name}. Bring passport, NIF, insurance card, medication list, allergy note.`,
  },
  {
    title: 'Tour apartments',
    state: 'in_progress',
    doneOffset: null,
    dueOffset: 3,
    notes: days =>
      `Two viewings ${days.monthDay(1)} (Alfama 11:00, Graça 15:30), two more ${days.monthDay(3)} (Mouraria 11:30, Campo de Ourique 16:00).`,
  },
  {
    title: 'Decide on long-term neighborhood',
    state: 'open',
    doneOffset: null,
    dueOffset: 11,
    notes: () =>
      'Shortlist: Alfama (charm, steep), Graça (views, steep, no metro), Mouraria (multicultural, fado), Campo de Ourique (residential, market, flatter).',
  },
  {
    title: 'Pick up the 35mm-equivalent camera lens',
    state: 'open',
    doneOffset: null,
    dueOffset: 3,
    notes: () =>
      `Order ${CAMERA_SHOP.orderNumber} ready for pickup at ${CAMERA_SHOP.name}. Fujifilm XF 23mm f/2. Collect it before the first photo session.`,
  },
  {
    title: 'Start Portuguese classes',
    state: 'in_progress',
    doneOffset: null,
    dueOffset: null,
    notes: () => 'A1 beginner, week 3. Homework: describe your neighborhood in Portuguese.',
  },
  {
    title: "Plan 'Old Lisbon' photo series",
    state: 'open',
    doneOffset: null,
    dueOffset: null,
    notes: days =>
      `Sessions: ${days.monthDay(4)} Alfama sunrise, ${days.monthDay(5)} Miradouro da Graça golden hour, ${days.monthDay(12)} Belém golden hour.`,
  },
];

function taskLine({ task, days }: { task: MayaTask; days: DayLabels }): string {
  const box = task.state === 'done' ? '[x]' : '[ ]';
  const status = task.state === 'in_progress' ? ' (in progress)' : '';
  const due = task.dueOffset === null ? '' : ` - due ${days.long(task.dueOffset)}`;
  const done = task.doneOffset === null ? '' : ` - done ${days.long(task.doneOffset)}`;
  const notes = task.notes(days);
  return `- ${box} ${task.title}${status}${due}${done}${notes === null ? '' : `\n  ${notes}`}`;
}

/** The Tasks space: open work first, then what is finished. */
export function tasksSpaceBody(days: DayLabels): string {
  const lines = (done: boolean): string[] =>
    MAYA_TASKS.filter(task => (task.state === 'done') === done).map(task => taskLine({ task, days }));
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
