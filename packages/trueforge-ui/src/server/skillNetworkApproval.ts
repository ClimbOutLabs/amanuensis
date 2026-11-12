/**
 * A skill's network approval: the sites it declares, the list the person approved, and whether a
 * declared site can send. The Harness adds these calls on top of the runtime's skill catalog port
 * so Settings can ask for the approval and take it back.
 *
 * The server owns the wire shape (`SkillNetworkApprovalSchema` in the Harness's
 * `schemas/skill.ts`); this module is its single owner on the client. It collapses into the
 * generated SDK once that carries `/settings/skills/{name}/network-approval`.
 */
import { z } from 'zod';

const SkillNetworkApprovalResponseSchema = z.object({
  data: z.object({
    declared_hosts: z.array(z.string()),
    approved_hosts: z.array(z.string()).nullable(),
    send_capable: z.boolean(),
  }),
});

export interface SkillNetworkApprovalState {
  /** The sites the skill says it needs. Empty means the skill declares none and never gets network. */
  declaredHosts: string[];
  /** The approved list in force, or null when there is none the sandbox may use. */
  approvedHosts: string[] | null;
  /** True when a declared site can send mail or change a calendar. */
  sendCapable: boolean;
}

export interface SkillNetworkApproval {
  /** Reads one skill's approval state. */
  getSkillNetworkApproval(req: { id: string }): Promise<SkillNetworkApprovalState>;
  /** Approves exactly the declared list the Settings panel showed. */
  approveSkillNetwork(req: { id: string; hosts: string[] }): Promise<SkillNetworkApprovalState>;
  /** Takes the approval back. The skill keeps no network access from the next run on. */
  revokeSkillNetwork(req: { id: string }): Promise<void>;
}

/**
 * Whether a catalog carries the approval calls. Another host's catalog may not, so the skills
 * page checks for them and leaves the approval panel out when they are absent.
 */
export function hasSkillNetworkApproval(catalog: object): catalog is SkillNetworkApproval {
  return (
    typeof Reflect.get(catalog, 'getSkillNetworkApproval') === 'function' &&
    typeof Reflect.get(catalog, 'approveSkillNetwork') === 'function' &&
    typeof Reflect.get(catalog, 'revokeSkillNetwork') === 'function'
  );
}

/**
 * Validates one approval response at the boundary and projects it onto the names the UI reads.
 * @throws {Error} when the body does not match the contract
 */
export function parseSkillNetworkApproval(body: unknown): SkillNetworkApprovalState {
  const parsed = SkillNetworkApprovalResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Skill network approval returned an unreadable response');
  }
  return {
    declaredHosts: parsed.data.data.declared_hosts,
    approvedHosts: parsed.data.data.approved_hosts,
    sendCapable: parsed.data.data.send_capable,
  };
}

/**
 * The lines the approval panel shows, in the design's words. Nothing here claims anything is
 * inspected or checked in flight: the approval is the trust decision, and the panel says so.
 */
export function skillNetworkApprovalLines(input: { skillName: string; state: SkillNetworkApprovalState }): string[] {
  const lines = [
    `The ${input.skillName} skill needs to reach these sites to work:`,
    'While this skill is switched on for a chat, that chat’s sandbox can contact these sites and no others. The skill can send any of your data to them, so only allow this for a skill you trust.',
  ];
  if (input.state.sendCapable) {
    lines.push(
      'One of these sites can send email. This skill will be able to send email as you, without asking each time.',
    );
  }
  return lines;
}

/** The line shown once the approval is in force, naming what ends it. */
export function skillNetworkApprovedLine(): string {
  return 'Network access is on for this skill. Chats using it can reach the sites above, and no others.';
}
