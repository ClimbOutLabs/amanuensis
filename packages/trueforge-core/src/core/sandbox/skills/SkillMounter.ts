import type { InstructionBuilder } from '../../InstructionBuilder';
import type { SandboxInit } from '../provider/Provider';
import { SKILL_DOWNLOAD_TIMEOUT_SECONDS, buildWriteAndRunScriptCommand } from '../Sandbox';
import { sandboxScripts } from '../sandboxScripts.gen';
import { SKILLS_PREAMBLE, getSkillPath, renderSkillPromptBody, type SkillPromptMode } from './constants';
import type { ISkillMounter } from './ISkillMounter';
import { copySkillsIntoSandbox, type SkillCopyDeps } from './slotSkillCopy';

// A git-sourced skill materialized by a sparse clone in the sandbox (git_downloader.py). By
// default only name/description/path are advertised in the prompt and their SKILL.md is read
// from disk at runtime; `SkillMounterOptions.promptMode: 'inline'` embeds preloaded SKILL.md
// content instead (via `SkillMounterOptions.inlineContent`). Wire fields match the agent_spec
// git mount (`url`/`path`/`name`/`ref`); the downloader resolves `ref` inside the sandbox
// before fetching.
export interface GitSkill {
  readonly type: 'git';
  readonly name: string;
  readonly description: string;
  // Canonical https clone URL of the github.com/gitlab.com repo (host-validated by the caller).
  readonly url: string;
  // Subdirectory within the repo that holds the skill (empty = repo root).
  readonly path: string;
  // Branch, tag, or full object id — resolved and fetched by skill_downloader.py in the sandbox.
  readonly ref: string;
  // Optional list of binary/command names required for this skill to function.
  readonly requires?: readonly string[] | undefined;
  // Optional trigger phrases describing when the agent should reach for this skill;
  // rendered as `when_to_use:` lines so the model can match them against the task.
  readonly when_to_use?: readonly string[] | undefined;
}

/** Registry skill: sandbox dir uses artifact `name`; AgentSpec stores `fqn`. */
interface RegistrySkill {
  readonly type: 'registry';
  readonly name: string;
  readonly description: string;
  // Version FQN from AgentSpec (`agent-skill:tenant/ml_repo/name:N`).
  readonly fqn: string;
  // When true, inline `skillMdContent` into the prompt instead of reading SKILL.md from disk.
  readonly preload: boolean;
  // SKILL.md body when `preload` is true; otherwise null.
  readonly skillMdContent: string | null;
  // Short-lived URL the sandbox uses to download the skill tarball.
  readonly presignedUrl: string;
}

export type Skill = GitSkill | RegistrySkill;

export const REQUESTED_SKILLS_FILE_NAME = '.tfy-requested-skills.json';
// Written by the host for an offline sandbox, so the in-sandbox downloader sees every skill as installed.
const DOWNLOADER_STATE_FILE_NAME = '.tfy-skill-downloader-state.json';

export interface OfflineSkillInit {
  /** Undefined when no skill could be copied, so nothing skills-related is sent. */
  init: SandboxInit | undefined;
  /** Skill name to the plain reason it was left out. */
  failed: ReadonlyMap<string, string>;
}

type RequestedGitSkill = Pick<GitSkill, 'type' | 'name' | 'url' | 'path' | 'ref'>;

type RequestedRegistrySkill = Pick<RegistrySkill, 'type' | 'name' | 'fqn'> & {
  // Host↔sandbox wire: JSON/Python use snake_case; RegistrySkill stays camelCase.
  presigned_url: RegistrySkill['presignedUrl'];
};

type RequestedSkill = RequestedGitSkill | RequestedRegistrySkill;

function toRequestedSkill(skill: Skill): RequestedSkill {
  switch (skill.type) {
    case 'registry': {
      const { name, fqn, presignedUrl: presigned_url } = skill;
      // Rename at upload: downloader reads `presigned_url`, never `presignedUrl`.
      return { type: 'registry', name, fqn, presigned_url };
    }
    case 'git': {
      const { name, url, path, ref } = skill;
      return { type: 'git', name, url, path, ref };
    }
    default: {
      const _exhaustive: never = skill;
      throw new Error(`unexpected skill: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Prompt-rendering options for a SkillMounter. */
export interface SkillMounterOptions {
  /**
   * 'advertise' (default) renders name/description/path and the model reads
   * SKILL.md itself; 'inline' embeds preloaded SKILL.md content per skill so
   * the model skips that read hop.
   */
  promptMode?: SkillPromptMode | undefined;
  /** Preloaded SKILL.md content by skill name; rendered only in 'inline' mode. */
  inlineContent?: ReadonlyMap<string, string> | undefined;
}

function isSkillArray(input: readonly Skill[] | { skills?: readonly Skill[] }): input is readonly Skill[] {
  return Array.isArray(input);
}

export class SkillMounter implements ISkillMounter {
  private readonly skills: readonly Skill[];
  private readonly promptMode: SkillPromptMode;
  private readonly inlineContent: ReadonlyMap<string, string>;

  constructor(input: readonly Skill[] | { skills?: readonly Skill[] } = {}, options?: SkillMounterOptions) {
    this.skills = isSkillArray(input) ? input : (input.skills ?? []);
    // 'advertise' is the safe default: no SKILL.md bytes enter the prompt unless
    // the caller opts into 'inline' and supplies preloaded content per skill.
    this.promptMode = options?.promptMode ?? 'advertise';
    // Clone: the caller may keep mutating the map they passed in.
    this.inlineContent = new Map(options?.inlineContent);
  }

  skillNames(): readonly string[] {
    return this.skills.map(skill => skill.name);
  }

  /**
   * Inline SKILL.md for the prompt: a registry skill carries its own per-skill
   * `preload` decision from the host regardless of `promptMode`; a git skill only
   * preloads when the mounter's `promptMode` is 'inline' and content was supplied.
   */
  private resolvePreloadContent(skill: Skill): string | null {
    switch (skill.type) {
      case 'registry':
        return skill.preload ? skill.skillMdContent : null;
      case 'git':
        return this.promptMode === 'inline' ? (this.inlineContent.get(skill.name) ?? null) : null;
      default: {
        const _exhaustive: never = skill;
        throw new Error(`unexpected skill: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  skillPrerequisites(): readonly { name: string; requires: readonly string[] }[] {
    return this.skills
      .filter(
        (skill): skill is GitSkill & { requires: readonly string[] } =>
          skill.type === 'git' && (skill.requires?.length ?? 0) > 0,
      )
      .map(skill => ({ name: skill.name, requires: skill.requires }));
  }

  instruction(
    builder: InstructionBuilder,
    paths: { skillsDir: string },
    unavailableSkills?: Map<string, string>,
  ): void {
    if (this.skills.length === 0) {
      return;
    }

    // Separate available and unavailable skills
    const available = this.skills.filter(skill => !unavailableSkills?.has(skill.name));
    const unavailable = this.skills.filter(skill => unavailableSkills?.has(skill.name));

    // The preamble describes mounted skills; with none mounted it would contradict the unavailable list.
    if (available.length > 0) {
      builder.addContent(SKILLS_PREAMBLE);
    }

    // Render available skills first
    for (const skill of available) {
      this.#addPromptSkill(builder, paths.skillsDir, {
        name: skill.name,
        description: skill.description,
        when_to_use: skill.type === 'git' ? skill.when_to_use : undefined,
        preloadContent: this.resolvePreloadContent(skill),
      });
    }

    // Then render unavailable skills with reasons
    if (unavailable.length > 0) {
      const unavailableNote = unavailable
        .map(skill => {
          const reason = unavailableSkills?.get(skill.name) ?? 'unknown reason';
          return `${skill.name}: unavailable (${reason})`;
        })
        .join('\n');

      builder.addSection(
        'unavailable-skills',
        `The following skills are unavailable in this sandbox:\n${unavailableNote}`,
      );
    }
  }

  getSandboxInit(paths: { skillsDir: string; skillDownloaderPath: string }): SandboxInit {
    // Always upload (including empty) so that existing skills are cleaned up.
    return {
      command: buildWriteAndRunScriptCommand({
        scriptPath: paths.skillDownloaderPath,
        scriptContent: sandboxScripts.skillDownloader,
      }),
      env: { TFY_SKILLS_DIR: paths.skillsDir },
      timeoutSeconds: SKILL_DOWNLOAD_TIMEOUT_SECONDS,
      uploads: [
        {
          remotePath: `${paths.skillsDir}/${REQUESTED_SKILLS_FILE_NAME}`,
          content: Buffer.from(JSON.stringify({ skills: this.skills.map(toRequestedSkill) }), 'utf-8'),
        },
      ],
    };
  }

  /**
   * Copies the skills into a sandbox with no network. The host fetches each one and writes the
   * downloader's requested and state files, so the in-sandbox run only confirms them and fetches nothing.
   */
  async getOfflineSandboxInit(
    paths: { skillsDir: string; skillDownloaderPath: string },
    deps: SkillCopyDeps = {},
  ): Promise<OfflineSkillInit> {
    if (this.skills.length === 0) {
      return { init: undefined, failed: new Map() };
    }
    const copy = await copySkillsIntoSandbox({ skills: this.skills, skillsDir: paths.skillsDir, deps });
    if (copy.copied.length === 0) {
      return { init: undefined, failed: copy.failed };
    }
    const requested = copy.copied.map(({ skill, objectId }) =>
      toRequestedSkill(skill.type === 'git' && objectId !== null ? { ...skill, ref: objectId } : skill),
    );
    const state = {
      downloaded_git_skills: copy.copied.flatMap(({ skill, objectId }) =>
        skill.type === 'git' && objectId !== null ? [{ name: skill.name, ref: objectId, path: skill.path }] : [],
      ),
      downloaded_registry_skills: copy.copied.flatMap(({ skill }) =>
        skill.type === 'registry' ? [{ fqn: skill.fqn, name: skill.name }] : [],
      ),
    };
    const command = [
      ...copy.unpackCommands,
      buildWriteAndRunScriptCommand({
        scriptPath: paths.skillDownloaderPath,
        scriptContent: sandboxScripts.skillDownloader,
      }),
    ].join(' && ');
    return {
      init: {
        command,
        env: { TFY_SKILLS_DIR: paths.skillsDir },
        timeoutSeconds: SKILL_DOWNLOAD_TIMEOUT_SECONDS,
        uploads: [
          {
            remotePath: `${paths.skillsDir}/${REQUESTED_SKILLS_FILE_NAME}`,
            content: Buffer.from(JSON.stringify({ skills: requested }), 'utf-8'),
          },
          {
            remotePath: `${paths.skillsDir}/${DOWNLOADER_STATE_FILE_NAME}`,
            content: Buffer.from(JSON.stringify(state), 'utf-8'),
          },
          ...copy.uploads,
        ],
      },
      failed: copy.failed,
    };
  }

  #addPromptSkill(
    builder: InstructionBuilder,
    skillsDir: string,
    skill: {
      name: string;
      description: string;
      when_to_use?: readonly string[] | undefined;
      preloadContent: string | null;
    },
  ): void {
    builder.addSection(
      'skill',
      renderSkillPromptBody({
        path: getSkillPath({ skillsDir, skillName: skill.name }),
        name: skill.name,
        description: skill.description,
        when_to_use: skill.when_to_use,
        preloadContent: skill.preloadContent,
      }),
    );
  }
}
