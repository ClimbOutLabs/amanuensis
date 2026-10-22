import { buildDemoWorld } from '../../../../src/cli/demoSeed/world';

const WORLD = buildDemoWorld({
  today: { year: 2026, month: 10, day: 26 },
  timeZone: 'Europe/Lisbon',
  modelName: 'demo/model',
});

function library(persona: string): string {
  return (WORLD.personas.find(candidate => candidate.content.display_name === persona)?.knowledge ?? [])
    .map(document => document.text)
    .join('\n');
}

function libraries(): string {
  return `${library('June')}\n${library('Theo')}`;
}

describe('the photo sessions', () => {
  it('speaks of light relative to sunset, never at a clock time it would have to compute', () => {
    const plan = library('Theo').split('## Planned sessions')[1] ?? '';

    expect(library('Theo')).toContain('an hour before sunset');
    expect(library('Theo')).not.toMatch(/sunset (is|at) (around|about)? ?\d/i);
    expect(plan).not.toMatch(/\d{1,2}:\d\d to \d{1,2}:\d\d/);
  });
});

describe('the libraries hold inputs only', () => {
  it('leaves the neighborhood decision open instead of answering it', () => {
    expect(libraries()).not.toContain('How they fit Maya');
    expect(libraries()).not.toContain('fits daily life best');
  });

  it('states no approximate figures', () => {
    const seeded = [libraries(), ...WORLD.notes.map(note => note.body)].join('\n');
    expect(seeded).not.toMatch(/\b(roughly|around|approximately|about) (\d|a|an|one|two|three|few)\b/i);
    expect(seeded).not.toMatch(/\d+-\d+ (minutes|hours|days)/);
  });
});

function tasks(): string {
  return WORLD.spaces.find(space => space.content.name === 'Tasks')?.content.body ?? '';
}

describe('the third photo session', () => {
  it('is Belém in the tasks, the library and the memories', () => {
    const series = WORLD.notes.find(note => note.key === 'photo-series')?.body ?? '';

    expect(tasks()).toContain('Belém golden hour');
    expect(library('Theo')).toContain('3. Belém golden hour');
    expect(series).toContain('Belém');
    expect(series).toContain('Mouraria as an optional extra');
  });

  it('keeps Mouraria only as an optional extra in the series plan', () => {
    const plan = library('Theo').split('## Planned sessions')[1] ?? '';
    const [sessions = '', extras = ''] = plan.split('## Optional extras');

    expect(sessions).not.toContain('Mouraria');
    expect(extras).toContain('Mouraria afternoon, an optional extra spot');
  });
});

describe('the rest of the world agrees with itself', () => {
  it('uses one camera: an interchangeable-lens body, since a new lens is waiting for pickup', () => {
    const everything = JSON.stringify(WORLD);

    expect(everything).not.toContain('X100V');
    expect(everything).toContain('X-T5');
    expect(everything).toContain('XF 23mm');
  });

  it('is due to pick up the lens before the first photo session, and finishes the viewings by their due date', () => {
    expect(tasks()).toContain('Pick up the 35mm-equivalent camera lens - due Thursday, October 29');
    expect(tasks()).toContain('Tour apartments (in progress) - due Thursday, October 29');
  });
});
