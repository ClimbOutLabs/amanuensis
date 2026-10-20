import type { InstructionBuilder } from '../../InstructionBuilder';
import type { SandboxInit } from '../provider/Provider';
import type { SkillCopyDeps, SkillCopyResult, StagedSkill } from './slotSkillCopy';

// A set of skills that describes itself in the prompt and installs itself into a sandbox. The sandbox
// holds one mounter and inspects individual skills only through this interface (prompt rendering,
// prerequisite checks, and skill-use telemetry).
export interface ISkillMounter {
  // Renders the <skills> section; adds nothing when empty, so InstructionBuilder drops the section.
  // unavailableSkills: map of skill name to reason why it's unavailable (missing prerequisite or no sandbox).
  instruction(builder: InstructionBuilder, paths: { skillsDir: string }, unavailableSkills?: Map<string, string>): void;
  // The command (+ env, timeout) that installs these skills; Sandbox folds it into its init exec.
  getSandboxInit(paths: { skillsDir: string; skillDownloaderPath: string }): SandboxInit;
  // The sandbox-without-network path: the host fetches and checks each skill first, then the init covers only the staged ones.
  planOfflineSkills(paths: { skillsDir: string; archiveDir: string }, deps?: SkillCopyDeps): Promise<SkillCopyResult>;
  offlineSkillsInit(
    paths: { skillsDir: string; skillDownloaderPath: string },
    accepted: readonly StagedSkill[],
  ): SandboxInit | undefined;
  // The subset of mounted skills that declare prerequisites, for Sandbox's prerequisite check.
  skillPrerequisites(): readonly { name: string; requires: readonly string[] }[];
  // Names of all mounted skills, for host-side skill-use telemetry.
  skillNames(): readonly string[];
}
