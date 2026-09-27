/**
 * Host-side skill-use telemetry: a passthrough turn event emitted when the agent
 * reaches for a mounted skill — either by reading its SKILL.md or by executing
 * with the skill directory as cwd. Detection lives in Sandbox.handleExec, which
 * is the one host choke point every sandbox exec passes through.
 *
 * This is the same passthrough-event mechanism as `aman.memory.recall` and
 * `aman.profile.learned`: the event rides the tool response's `events` field,
 * executeToolCalls collects it untouched, and AgentThread yields it as a turn
 * event. No AgentThread/executeToolCalls changes needed.
 */
import { z } from '@hono/zod-openapi';
import { newEventId } from '../../events/schema';

/** Passthrough event type for skill use. */
export const SKILL_USED_EVENT_TYPE = 'aman.skill.used' as const;

/** How the agent reached for the skill. */
export const SkillUsedKindSchema = z
  .enum(['skill_read', 'skill_dir_exec'])
  .describe(
    "'skill_read': an exec referenced <skillsDir>/<name>/SKILL.md. " +
      "'skill_dir_exec': an exec ran with a skill directory as cwd.",
  );

export type SkillUsedKind = z.infer<typeof SkillUsedKindSchema>;

/** Payload of the `aman.skill.used` passthrough event. */
export const SkillUsedEventSchema = z
  .object({
    type: z.literal(SKILL_USED_EVENT_TYPE).describe('Emitted when the agent uses a mounted skill.'),
    skill_name: z.string().describe('Name of the mounted skill the agent reached for.'),
    kind: SkillUsedKindSchema,
  })
  .openapi('SkillUsedEvent');

export type SkillUsedEvent = z.infer<typeof SkillUsedEventSchema>;

/**
 * Registers `aman.skill.used` in the harness's passthrough event registry. The
 * augmentation targets the exact module that declares
 * `AgentPassthroughEventSchemaMap` (same in-package pattern as the cross-package
 * registrations in trueforge's runtime/memory/memoryEvents.ts), so the event
 * type-checks everywhere trueforge-core sources are compiled — including the
 * trueforge package via the `trueforge-dev` export condition.
 *
 * Note: this module deliberately does not import `RegisteredPassthroughEvent`.
 * Referencing the registry union here would evaluate it while this module is
 * still being processed — before this augmentation has merged — and TypeScript
 * caches that stale evaluation. The concrete `SkillUsedEventEnvelope` below is
 * structurally identical to the registered member, so it stays assignable to
 * the union wherever the union is evaluated after the augmentation merges.
 */
declare module '../../events/PassthroughEvents' {
  interface AgentPassthroughEventSchemaMap {
    'aman.skill.used': typeof SkillUsedEventSchema;
  }
}

/** A fully-formed `aman.skill.used` event: schema payload plus the passthrough envelope. */
export type SkillUsedEventEnvelope = SkillUsedEvent & {
  id: string;
  created_at: string;
};

/** Builds a fully-formed `aman.skill.used` event (durable id + timestamp stamped). */
export function buildSkillUsedEvent(input: { skill_name: string; kind: SkillUsedKind }): SkillUsedEventEnvelope {
  return {
    type: SKILL_USED_EVENT_TYPE,
    id: newEventId(),
    created_at: new Date().toISOString(),
    skill_name: input.skill_name,
    kind: input.kind,
  };
}

/**
 * Detects when an exec reaches for a mounted skill: a `skill_read` event when
 * the authored command references `<skillsDir>/<name>/SKILL.md`, a
 * `skill_dir_exec` event when the exec cwd sits inside a skill directory.
 * Detection is textual — it sees the command the model authored and the cwd it
 * chose, not reads performed through other tools — and it matches the exact
 * paths the <skills> prompt section advertises, so quoting around a path still
 * matches. Pure string matching, cheap enough to run on every exec. Exported
 * for unit tests; the production caller is Sandbox.handleExec, the one host
 * choke point every sandbox exec passes through.
 */
export function detectSkillUsedEvents(input: {
  command: string;
  cwd: string | undefined;
  skillsDir: string;
  skillNames: readonly string[];
}): SkillUsedEventEnvelope[] {
  const names = input.skillNames;
  if (names.length === 0) {
    return [];
  }
  const skillsDir = input.skillsDir.replace(/\/+$/, '');
  const events: SkillUsedEventEnvelope[] = [];
  const seen = new Set<string>();
  const emit = (skillName: string, kind: SkillUsedKind): void => {
    const key = `${skillName}${kind}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    events.push(buildSkillUsedEvent({ skill_name: skillName, kind }));
  };
  for (const name of names) {
    if (input.command.includes(`${skillsDir}/${name}/SKILL.md`)) {
      emit(name, 'skill_read');
    }
  }
  // No cwd chosen (provider default) — nothing to match against skill dirs.
  if (input.cwd === undefined) {
    return events;
  }
  const cwd = input.cwd.replace(/\/+$/, '');
  if (cwd.startsWith(`${skillsDir}/`)) {
    const firstSegment = cwd.slice(skillsDir.length + 1).split('/')[0];
    if (firstSegment !== undefined && names.includes(firstSegment)) {
      emit(firstSegment, 'skill_dir_exec');
    }
  }
  return events;
}
