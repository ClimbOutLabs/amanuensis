/**
 * Skill-use telemetry detection: the pure string matching that decides when an
 * exec reached for a mounted skill. (Production caller is Sandbox.handleExec,
 * which feeds the events into the tool response's passthrough `events` field.)
 */
import { SKILL_USED_EVENT_TYPE, detectSkillUsedEvents } from '../../../../src/core/sandbox/skills/skillEvents';

const SKILLS_DIR = '/var/aman/skills';
const NAMES = ['github', 'linear'] as const;

function detect(input: {
  command: string;
  cwd?: string | undefined;
  skillsDir?: string | undefined;
  skillNames?: readonly string[] | undefined;
}) {
  return detectSkillUsedEvents({
    command: input.command,
    cwd: input.cwd,
    skillsDir: input.skillsDir ?? SKILLS_DIR,
    skillNames: input.skillNames ?? [...NAMES],
  });
}

describe('detectSkillUsedEvents', () => {
  it('returns no events when no skills are mounted', () => {
    expect(
      detect({
        command: `cat ${SKILLS_DIR}/github/SKILL.md`,
        cwd: `${SKILLS_DIR}/github`,
        skillNames: [],
      }),
    ).toEqual([]);
  });

  it('emits skill_read when the command references a mounted skill SKILL.md', () => {
    const events = detect({ command: `cat ${SKILLS_DIR}/github/SKILL.md | head -50` });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: SKILL_USED_EVENT_TYPE,
      skill_name: 'github',
      kind: 'skill_read',
    });
    expect(typeof events[0]?.id).toBe('string');
    expect(typeof events[0]?.created_at).toBe('string');
  });

  it('matches quoted SKILL.md paths the prompt advertises', () => {
    const events = detect({ command: `cat "${SKILLS_DIR}/linear/SKILL.md"` });
    expect(events.map(event => event.skill_name)).toEqual(['linear']);
    expect(events[0]?.kind).toBe('skill_read');
  });

  it('ignores SKILL.md references for skills that are not mounted', () => {
    expect(detect({ command: `cat ${SKILLS_DIR}/notion/SKILL.md` })).toEqual([]);
  });

  it('emits skill_dir_exec when the exec cwd sits inside a skill directory', () => {
    const events = detect({ command: 'ls', cwd: `${SKILLS_DIR}/github` });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: SKILL_USED_EVENT_TYPE,
      skill_name: 'github',
      kind: 'skill_dir_exec',
    });
  });

  it('matches nested cwd paths under a skill directory', () => {
    const events = detect({ command: 'make test', cwd: `${SKILLS_DIR}/linear/scripts` });
    expect(events.map(event => [event.skill_name, event.kind])).toEqual([['linear', 'skill_dir_exec']]);
  });

  it('does not treat the skills dir itself or unknown dirs as skill use', () => {
    expect(detect({ command: 'ls', cwd: SKILLS_DIR })).toEqual([]);
    expect(detect({ command: 'ls', cwd: '/var/aman/work' })).toEqual([]);
    expect(detect({ command: 'ls', cwd: `${SKILLS_DIR}/notion` })).toEqual([]);
  });

  it('still detects skill reads when no cwd was chosen', () => {
    const events = detect({ command: `cat ${SKILLS_DIR}/github/SKILL.md`, cwd: undefined });
    expect(events.map(event => event.kind)).toEqual(['skill_read']);
  });

  it('emits both kinds when the command reads one skill while cwd is in another', () => {
    const events = detect({
      command: `cat ${SKILLS_DIR}/github/SKILL.md`,
      cwd: `${SKILLS_DIR}/linear`,
    });
    expect(events.map(event => [event.skill_name, event.kind])).toEqual([
      ['github', 'skill_read'],
      ['linear', 'skill_dir_exec'],
    ]);
  });

  it('dedupes repeated references to the same skill and kind', () => {
    const events = detect({
      command: `cat ${SKILLS_DIR}/github/SKILL.md && cat ${SKILLS_DIR}/github/SKILL.md`,
      cwd: `${SKILLS_DIR}/github/subdir`,
    });
    expect(events.map(event => [event.skill_name, event.kind])).toEqual([
      ['github', 'skill_read'],
      ['github', 'skill_dir_exec'],
    ]);
  });

  it('tolerates trailing slashes on the skills dir and cwd', () => {
    const events = detect({
      command: `cat ${SKILLS_DIR}/github/SKILL.md`,
      cwd: `${SKILLS_DIR}/linear/`,
      skillsDir: `${SKILLS_DIR}/`,
    });
    expect(events.map(event => [event.skill_name, event.kind])).toEqual([
      ['github', 'skill_read'],
      ['linear', 'skill_dir_exec'],
    ]);
  });
});
