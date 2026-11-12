/**
 * Configured skill domain + wire schemas (`skill.manifest` JSONB and list projections).
 * Catalog presets live in skillCatalog.ts.
 * SkillManifest is a `type`-discriminated oneOf of GitSkill | TrueFoundryRegistrySkill.
 */
import { z } from '@hono/zod-openapi';
import { NameSchema } from './common';

const SKILL_TYPES = ['git', 'truefoundry'] as const;

/** OpenAPI + persisted discriminant (`git` | `truefoundry`) — same pattern as MCPServerType. */
export const SkillTypeSchema = z.enum(SKILL_TYPES).openapi('SkillType');

// GitHub is exactly owner/repo; GitLab allows subgroups (group[/subgroup...]/project, ≥2 segments).
const GIT_URL_REGEX =
  /^https:\/\/(github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|gitlab\.com\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)(\/|\.git)?$/;
const GIT_REF_REGEX = /^[A-Za-z0-9._\-/]+$/;
const SKILL_PATH_REGEX = /^[A-Za-z0-9._\-/]+$/;
const hasParentTraversal = (value: string): boolean => value.split('/').includes('..');

/** Shared with catalog presets — GitHub/GitLab HTTPS only. */
export const SkillGitUrlSchema = z
  .string()
  .trim()
  .min(1)
  .regex(GIT_URL_REGEX, 'Must be a GitHub or GitLab HTTPS URL')
  .refine(v => !hasParentTraversal(v), 'URL must not contain ".." segments')
  .describe('Full HTTPS URL of a GitHub or GitLab repository.');

/** Shared with catalog presets. Omit to use the repository root. */
export const SkillGitPathSchema = z
  .string()
  .trim()
  .min(1)
  .regex(SKILL_PATH_REGEX, 'Path may only contain letters, numbers, ".", "_", "-", and "/"')
  .refine(v => !hasParentTraversal(v), 'Path must not contain ".." segments')
  .refine(v => !v.split('/').includes('.'), 'Path must not contain "." segments')
  .refine(v => v.replace(/^\/+|\/+$/g, '').length > 0, 'Path must reference a subdirectory, not only slashes')
  .describe('Path to the skill directory within the repository. Omit to use the repository root.');

/**
 * Shared with catalog presets. Required on configured skills (no silent HEAD default).
 */
export const SkillGitRefSchema = z
  .string()
  .trim()
  .min(1)
  .regex(GIT_REF_REGEX, 'Ref may only contain letters, numbers, ".", "_", "-", and "/"')
  .refine(v => !hasParentTraversal(v), 'Ref must not contain ".." segments')
  .refine(v => v.replace(/^\/+|\/+$/g, '').length > 0, 'Ref must not consist only of slashes')
  .describe('Git ref — branch name, tag, or commit SHA.');

export const SkillDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .describe('Concise guidance for when the agent should use the skill.');

/** Prerequisites: binary/command names required for the skill to function. */
export const SkillRequiresSchema = z
  .array(z.string().trim().min(1))
  .describe('List of binary/command names required for this skill to function.');

/**
 * Trigger phrases describing when the agent should reach for the skill.
 * Rendered as `when_to_use:` lines in the <skills> prompt section alongside
 * the description, so the model can match them against the current task.
 * Optional and backward compatible: existing manifests without this key keep
 * validating unchanged, so no data migration is needed.
 */
export const SkillWhenToUseSchema = z
  .array(z.string().trim().min(1))
  .describe('Trigger phrases describing when the agent should use the skill.');

/**
 * One site a skill declares it needs to reach: an exact host name, lowercase, with no scheme, port
 * or path, and never a wildcard or an IP address. The gateway matches this name exactly, so
 * anything looser would approve more than the person was shown.
 */
const SKILL_NETWORK_HOST_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export const SkillNetworkHostSchema = z
  .string()
  .trim()
  .max(253)
  .regex(
    SKILL_NETWORK_HOST_REGEX,
    'Must be an exact site name like gmail.googleapis.com, with no https://, port, path or *',
  )
  .refine(v => !v.split('.').every(label => /^\d+$/.test(label)), 'Must be a site name, not an IP address')
  .describe('One exact site name the skill needs to reach.');

/**
 * The sites a skill declares it needs. Optional and backward compatible like `when_to_use`: a
 * skill that declares nothing gets no network, and nothing about it changes. Naming a site here
 * grants nothing by itself; the person approves the list in Settings first.
 */
export const SkillNetworkHostsSchema = z
  .array(SkillNetworkHostSchema)
  .max(20)
  .transform(hosts => [...new Set(hosts)])
  .describe('Exact site names the skill needs to reach. The person approves this list in Settings.');

/**
 * Built-in list of sites where a skill can send mail or change a calendar. When a declared list
 * names one of these, the approval in Settings says so in plain words, because approving the site
 * approves the sending too: the gateway cannot see inside the encrypted connection to tell a read
 * from a send.
 */
export const SKILL_NETWORK_SEND_CAPABLE_HOSTS: readonly string[] = [
  'gmail.googleapis.com',
  'www.googleapis.com',
  'graph.microsoft.com',
  'outlook.office365.com',
];

/** True when any of the given sites can send mail or change a calendar. */
export function skillNetworkHostsCanSend(hosts: readonly string[]): boolean {
  return hosts.some(host => SKILL_NETWORK_SEND_CAPABLE_HOSTS.includes(host));
}

/**
 * The sites a skill may reach right now, from what it declares and what the person approved.
 * Hosts removed from the declaration drop out on their own. A host added to the declaration is
 * not covered by an earlier approval, so nothing is granted until the person approves the new
 * full list: the approval counts only when it covers every declared site.
 */
export function effectiveSkillNetworkHosts(input: {
  declared: readonly string[] | undefined;
  approved: readonly string[] | null;
}): readonly string[] | null {
  const declared = input.declared ?? [];
  if (input.approved === null || declared.length === 0) {
    return null;
  }
  const approved = new Set(input.approved);
  return declared.every(host => approved.has(host)) ? declared : null;
}

/** Configured skill document persisted as `skill.manifest`. */
const GitSkillSchema = z
  .object({
    type: z.literal(SkillTypeSchema.enum.git),
    name: NameSchema,
    url: SkillGitUrlSchema,
    path: SkillGitPathSchema.optional(),
    ref: SkillGitRefSchema,
    description: SkillDescriptionSchema,
    requires: SkillRequiresSchema.optional(),
    when_to_use: SkillWhenToUseSchema.optional(),
    network_hosts: SkillNetworkHostsSchema.optional(),
  })
  .strict()
  .openapi('GitSkill');

/** TrueFoundry registry catalog row: `name` is the version FQN; `display_name` is the short SFY name. */
const TrueFoundryRegistrySkillSchema = z
  .object({
    type: z.literal(SkillTypeSchema.enum.truefoundry),
    name: z.string().min(1),
    display_name: z.string().min(1),
    description: SkillDescriptionSchema,
    repository_name: z.string().min(1).describe('Repo where the skill is registered.'),
    version: z.number().int().positive(),
  })
  .strict()
  .openapi('TrueFoundryRegistrySkill');

export const SkillManifestSchema = z
  .discriminatedUnion('type', [GitSkillSchema, TrueFoundryRegistrySkillSchema])
  .openapi('SkillManifest');

export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export type GitSkill = z.infer<typeof GitSkillSchema>;
export type TrueFoundryRegistrySkill = z.infer<typeof TrueFoundryRegistrySkillSchema>;

/** Narrow SkillManifest → git mount shape for turn resolve. */
export function parseGitSkill(manifest: SkillManifest): GitSkill | undefined {
  return manifest.type === 'git' ? manifest : undefined;
}

/** Narrow SkillManifest → TrueFoundry registry catalog shape for chat list projection. */
export function parseTrueFoundryRegistrySkill(manifest: SkillManifest): TrueFoundryRegistrySkill | undefined {
  return manifest.type === 'truefoundry' ? manifest : undefined;
}

/** Admin/settings wire view: identity column plus nested manifest. */
export const ConfiguredSkillSchema = z
  .object({
    name: z.string().min(1),
    manifest: SkillManifestSchema,
  })
  .strict()
  .openapi('ConfiguredSkill');

/** Create/update $ref SkillManifest so OpenAPI SkillType stays git|truefoundry. */
export const CreateSkillRequestSchema = z
  .object({
    manifest: SkillManifestSchema,
  })
  .strict()
  .openapi('CreateSkillRequest');

export const UpdateSkillRequestSchema = z
  .object({
    manifest: SkillManifestSchema,
  })
  .strict()
  .openapi('UpdateSkillRequest');

export const GetSkillResponseSchema = z.object({ data: ConfiguredSkillSchema }).openapi('GetSkillResponse');
export const ListSkillsResponseSchema = z
  .object({ data: z.array(ConfiguredSkillSchema) })
  .openapi('ListSkillsResponse');
export const DeleteSkillResponseSchema = z.object({}).openapi('DeleteSkillResponse');

/** Path params for the delete route, reusing the canonical skill NameSchema. */
export const SkillNameParamsSchema = z.object({ name: NameSchema }).openapi('SkillNameParams');

/** Chat/composer read view — discovery fields only. */
export const AvailableSkillSchema = z
  .object({
    name: z.string().min(1).describe('Skill name.'),
    description: SkillDescriptionSchema,
    metadata: z.record(z.string(), z.string()).optional().describe('Optional skill metadata.'),
  })
  .strict()
  .openapi('AvailableSkill');

export const ListAvailableSkillsResponseSchema = z
  .object({ data: z.array(AvailableSkillSchema) })
  .openapi('ListAvailableSkillsResponse');

/** Versions list query — skill name (or registry FQN). */
export const ListSkillVersionsRequestQuerySchema = z
  .object({
    name: z.string().min(1).describe('Skill name.'),
  })
  .openapi('ListSkillVersionsRequestQuery');

/** One version row for the TrueFoundry skill picker dropdown. `name` is the version FQN. */
export const SkillVersionSchema = z
  .object({
    name: z.string().min(1),
    display_name: z.string().min(1),
    description: SkillDescriptionSchema,
    version: z.number().int().positive(),
  })
  .strict()
  .openapi('SkillVersion');

export const ListSkillVersionsResponseSchema = z
  .object({ data: z.array(SkillVersionSchema) })
  .openapi('ListSkillVersionsResponse');

/**
 * Network approval state of one skill, as Settings shows it. `approved_hosts` is the list in
 * force right now: null when the person has not approved, or when the skill's declared list grew
 * past what they approved and they need to approve the new full list.
 */
export const SkillNetworkApprovalSchema = z
  .object({
    declared_hosts: SkillNetworkHostsSchema,
    approved_hosts: z.array(SkillNetworkHostSchema).nullable(),
    send_capable: z.boolean().describe('True when a declared site can send mail or change a calendar.'),
  })
  .strict()
  .openapi('SkillNetworkApproval');

export const GetSkillNetworkApprovalResponseSchema = z
  .object({ data: SkillNetworkApprovalSchema })
  .openapi('GetSkillNetworkApprovalResponse');

/** The approval the person is giving. It must name the skill's declared sites exactly, no more, no fewer. */
export const UpdateSkillNetworkApprovalRequestSchema = z
  .object({
    hosts: SkillNetworkHostsSchema,
  })
  .strict()
  .openapi('UpdateSkillNetworkApprovalRequest');

export const UpdateSkillNetworkApprovalResponseSchema = z
  .object({ data: SkillNetworkApprovalSchema })
  .openapi('UpdateSkillNetworkApprovalResponse');

export const DeleteSkillNetworkApprovalResponseSchema = z.object({}).openapi('DeleteSkillNetworkApprovalResponse');

export type ConfiguredSkill = z.infer<typeof ConfiguredSkillSchema>;
export type CreateSkillRequest = z.infer<typeof CreateSkillRequestSchema>;
export type UpdateSkillRequest = z.infer<typeof UpdateSkillRequestSchema>;
export type AvailableSkill = z.infer<typeof AvailableSkillSchema>;
export type SkillVersion = z.infer<typeof SkillVersionSchema>;
export type SkillNetworkApproval = z.infer<typeof SkillNetworkApprovalSchema>;
export type UpdateSkillNetworkApprovalRequest = z.infer<typeof UpdateSkillNetworkApprovalRequestSchema>;
