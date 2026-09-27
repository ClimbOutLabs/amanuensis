/**
 * SkillMounter: prompt rendering and the declarative sandbox init it hands to Sandbox.
 */
import { InstructionBuilder } from '../../../../src/core/InstructionBuilder';
import type { ISkillMounter } from '../../../../src/core/sandbox/skills/ISkillMounter';
import {
  REQUESTED_SKILLS_FILE_NAME,
  SkillMounter,
  type GitSkill,
  type Skill,
} from '../../../../src/core/sandbox/skills/SkillMounter';

const GIT_SKILL = {
  type: 'git',
  name: 'git-skill',
  description: 'From git',
  url: 'https://github.com/acme/skills.git',
  path: '',
  ref: 'a'.repeat(40),
} satisfies GitSkill;

const GIT_SKILL_WITH_REQUIRES = {
  type: 'git',
  name: 'git-skill-tvly',
  description: 'Uses Tavily',
  url: 'https://github.com/acme/skills.git',
  path: '',
  ref: 'a'.repeat(40),
  requires: ['tvly'],
} satisfies GitSkill;

const REGISTRY_SKILL = {
  type: 'registry',
  name: 'echo',
  description: 'Echo',
  fqn: 'agent-skill:acme/team/echo:1',
  preload: false,
  skillMdContent: null,
  presignedUrl: 'https://example.com/echo.tar',
} satisfies Skill;

const PATHS = {
  skillsDir: '/custom/skills',
  skillDownloaderPath: '/custom/skill_downloader.py',
};

// Renders a mounter's <skills> section the same way Sandbox does (empty section => '').
function renderSkills(mounter: ISkillMounter, unavailableSkills?: Map<string, string>): string {
  const builder = new InstructionBuilder('skills');
  mounter.instruction(builder, { skillsDir: PATHS.skillsDir }, unavailableSkills);
  return builder.build();
}

function readRequestedFile(mounter: SkillMounter): unknown {
  const { uploads } = mounter.getSandboxInit(PATHS);
  expect(uploads).toHaveLength(1);
  const content = uploads[0]?.content.toString('utf-8');
  expect(typeof content).toBe('string');
  return JSON.parse(content ?? '');
}

describe('SkillMounter', () => {
  it('uploads git skills in the requested file and points the init command at the downloader', () => {
    const mounter = new SkillMounter({ skills: [GIT_SKILL] });
    const init = mounter.getSandboxInit(PATHS);

    expect(init.command).toContain(PATHS.skillDownloaderPath);
    expect(init.env?.['TFY_SKILLS_DIR']).toBe(PATHS.skillsDir);
    expect(init.timeoutSeconds).toBe(180);
    expect(init.uploads[0]?.remotePath).toBe(`${PATHS.skillsDir}/${REQUESTED_SKILLS_FILE_NAME}`);
    expect(readRequestedFile(mounter)).toEqual({
      skills: [{ type: 'git', name: 'git-skill', url: GIT_SKILL.url, path: '', ref: GIT_SKILL.ref }],
    });
  });

  it('renders skill prompt blocks under the injected skills dir', () => {
    const rendered = renderSkills(new SkillMounter({ skills: [GIT_SKILL] }));
    expect(rendered).toContain('<skills>');
    expect(rendered).toContain(`${PATHS.skillsDir}/git-skill`);
  });

  it('uploads an empty requested file so that existing skills are cleaned up', () => {
    const mounter = new SkillMounter({});
    expect(renderSkills(mounter)).toBe('');
    expect(readRequestedFile(mounter)).toEqual({ skills: [] });
  });

  it('writes git and registry entries into one requested file in caller order', () => {
    expect(readRequestedFile(new SkillMounter({ skills: [GIT_SKILL, REGISTRY_SKILL] }))).toEqual({
      skills: [
        { type: 'git', name: 'git-skill', url: GIT_SKILL.url, path: '', ref: GIT_SKILL.ref },
        {
          type: 'registry',
          name: 'echo',
          fqn: 'agent-skill:acme/team/echo:1',
          presigned_url: 'https://example.com/echo.tar',
        },
      ],
    });
  });

  it('marks skills with missing prerequisites as unavailable', () => {
    const mounter = new SkillMounter({ skills: [GIT_SKILL_WITH_REQUIRES] });
    const unavailable = new Map([['git-skill-tvly', 'missing prerequisite: tvly']]);
    const rendered = renderSkills(mounter, unavailable);

    expect(rendered).toContain('<unavailable-skills>');
    expect(rendered).toContain('git-skill-tvly');
    expect(rendered).toContain('missing prerequisite: tvly');
    expect(rendered).not.toContain('git-skill-tvly</skill>'); // Should not be in available section
  });

  it('separates available and unavailable skills in the prompt', () => {
    const mounter = new SkillMounter({ skills: [GIT_SKILL, GIT_SKILL_WITH_REQUIRES] });
    const unavailable = new Map([['git-skill-tvly', 'missing prerequisite: tvly']]);
    const rendered = renderSkills(mounter, unavailable);

    // Available skill should be present
    expect(rendered).toContain('<skill>');
    expect(rendered).toContain('git-skill');
    expect(rendered).toContain('/custom/skills/git-skill');

    // Unavailable skill should be marked as unavailable
    expect(rendered).toContain('<unavailable-skills>');
    expect(rendered).toContain('git-skill-tvly');
  });

  it('preserves the requires field on skillPrerequisites', () => {
    const mounter = new SkillMounter({ skills: [GIT_SKILL_WITH_REQUIRES] });
    const prerequisites = mounter.skillPrerequisites();

    expect(prerequisites).toEqual([{ name: 'git-skill-tvly', requires: ['tvly'] }]);
  });

  it('marks only skills with missing binaries as unavailable when some binaries exist', () => {
    const skillWithTvly = {
      type: 'git',
      name: 'tavily-research',
      description: 'Uses Tavily',
      url: 'https://github.com/acme/skills.git',
      path: '',
      ref: 'a'.repeat(40),
      requires: ['tvly'],
    } satisfies GitSkill;
    const skillWithJq = {
      type: 'git',
      name: 'json-processor',
      description: 'Uses jq',
      url: 'https://github.com/acme/skills.git',
      path: '',
      ref: 'a'.repeat(40),
      requires: ['jq'],
    } satisfies GitSkill;

    const mounter = new SkillMounter({ skills: [skillWithTvly, skillWithJq] });
    // tvly is missing, jq is available
    const unavailable = new Map([['tavily-research', 'missing prerequisite: tvly']]);
    const rendered = renderSkills(mounter, unavailable);

    expect(rendered).toContain('<skill>');
    expect(rendered).toContain('json-processor'); // Available skill
    expect(rendered).toContain('/custom/skills/json-processor');

    expect(rendered).toContain('<unavailable-skills>');
    expect(rendered).toContain('tavily-research'); // Only unavailable skill
    expect(rendered).toContain('missing prerequisite: tvly');

    // Ensure json-processor is not in unavailable section
    expect(rendered).not.toContain('json-processor: unavailable');
  });
});

describe('SkillMounter skill routing (track 2)', () => {
  const SKILL_WITH_TRIGGERS = {
    ...GIT_SKILL,
    when_to_use: ['summarize a long document', 'extract action items from notes'],
  };

  it('tells the agent it MUST prefer a matching skill over generic tools', () => {
    const rendered = renderSkills(new SkillMounter([GIT_SKILL]));

    expect(rendered).toContain('MUST use that skill');
    expect(rendered).toContain('MUST NOT substitute generic exec/file/MCP/web tools');
  });

  it('renders when_to_use triggers as bullet lines in the skill block', () => {
    const rendered = renderSkills(new SkillMounter([SKILL_WITH_TRIGGERS]));

    expect(rendered).toContain('when_to_use:');
    expect(rendered).toContain('- summarize a long document');
    expect(rendered).toContain('- extract action items from notes');
  });

  it('omits the when_to_use section when the skill declares no triggers', () => {
    const rendered = renderSkills(new SkillMounter([GIT_SKILL]));

    expect(rendered).not.toContain('when_to_use:');
  });

  it('inline mode embeds preloaded SKILL.md content so the agent skips the read hop', () => {
    const content = '# Demo skill\n\nUse this to summarize documents.';
    const mounter = new SkillMounter([GIT_SKILL], {
      promptMode: 'inline',
      inlineContent: new Map([[GIT_SKILL.name, content]]),
    });
    const rendered = renderSkills(mounter);

    expect(rendered).toContain('SKILL.md content:');
    expect(rendered).toContain(content);
    // Name/description/path still advertised alongside the inlined content.
    expect(rendered).toContain('git-skill');
  });

  it('advertise mode never embeds SKILL.md content, even when content is supplied', () => {
    const mounter = new SkillMounter([GIT_SKILL], {
      promptMode: 'advertise',
      inlineContent: new Map([[GIT_SKILL.name, '# Demo skill']]),
    });
    const rendered = renderSkills(mounter);

    expect(rendered).not.toContain('SKILL.md content:');
    expect(rendered).toContain('git-skill');
  });

  it('inline mode falls back to advertising a skill with no preloaded content', () => {
    const mounter = new SkillMounter([GIT_SKILL], { promptMode: 'inline' });
    const rendered = renderSkills(mounter);

    expect(rendered).not.toContain('SKILL.md content:');
    expect(rendered).toContain('description: From git');
  });

  it('exposes mounted skill names for host-side telemetry', () => {
    const mounter = new SkillMounter([GIT_SKILL, GIT_SKILL_WITH_REQUIRES]);

    expect(mounter.skillNames()).toEqual(['git-skill', 'git-skill-tvly']);
  });
});
