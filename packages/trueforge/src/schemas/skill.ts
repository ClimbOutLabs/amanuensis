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
 * True when the value is a site name in the form above: an exact host name, never a bare
 * address. Every place a host arrives from outside a skill's own declaration (a connection
 * request, a card answer) is checked with this before the host is recorded, granted or
 * connected to, so a bare address can never be named on a card or stored as an approval.
 */
export function isSkillNetworkHostName(value: string): boolean {
  return SkillNetworkHostSchema.safeParse(value).success;
}

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
 * list: the approval counts only when it covers every declared site. A site the person turned
 * down is the one exception: it neither counts against the approval nor is granted by it, so
 * turning one site down does not switch off the sites the person did approve. The turned-down
 * site stays out, and since the stored approval never named it, clearing its denial grants
 * nothing either: the list needs a fresh approval first.
 */
export function effectiveSkillNetworkHosts(input: {
  declared: readonly string[] | undefined;
  approved: readonly string[] | null;
  denied: readonly string[];
}): readonly string[] | null {
  const declared = input.declared ?? [];
  if (input.approved === null || declared.length === 0) {
    return null;
  }
  const denied = new Set(input.denied);
  const inForce = declared.filter(host => !denied.has(host));
  if (inForce.length === 0) {
    return null;
  }
  const approved = new Set(input.approved);
  return inForce.every(host => approved.has(host)) ? inForce : null;
}

/**
 * Every site a skill may reach, from all the ways the person allowed it: the declared list when
 * its approval is in force, each site allowed on its own (from a card or Settings), and the
 * session's allow-once sites. A denied site is never included, even when another rule names it:
 * a denial is the person's latest word on that site until they clear it in Settings.
 */
export function grantedSkillNetworkHosts(input: {
  declared: readonly string[] | undefined;
  approved: readonly string[] | null;
  allowed: readonly string[];
  denied: readonly string[];
  session: readonly string[];
}): readonly string[] {
  const denied = new Set(input.denied);
  const hosts = new Set<string>();
  const effective = effectiveSkillNetworkHosts({
    declared: input.declared,
    approved: input.approved,
    denied: input.denied,
  });
  for (const host of effective ?? []) {
    hosts.add(host);
  }
  for (const host of input.allowed) {
    hosts.add(host);
  }
  for (const host of input.session) {
    hosts.add(host);
  }
  for (const host of denied) {
    hosts.delete(host);
  }
  return [...hosts];
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
 * Network approval state of one skill, as Settings shows it. `approved_hosts` is the declared
 * list in force right now: null when the person has not approved, or when the skill's declared
 * list grew past what they approved and they need to approve the new full list. `allowed_hosts`
 * are sites allowed one by one, `denied_hosts` are sites the person turned down, and
 * `session_hosts` are sites allowed once in a chat that is still open.
 */
export const SkillNetworkApprovalSchema = z
  .object({
    declared_hosts: SkillNetworkHostsSchema,
    approved_hosts: z.array(SkillNetworkHostSchema).nullable(),
    allowed_hosts: z.array(SkillNetworkHostSchema),
    denied_hosts: z.array(SkillNetworkHostSchema),
    session_hosts: z.array(SkillNetworkHostSchema),
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

/** One site the person is allowing or turning down for a skill, apart from the declared list. */
export const UpdateSkillNetworkHostRequestSchema = z
  .object({
    host: SkillNetworkHostSchema,
  })
  .strict()
  .openapi('UpdateSkillNetworkHostRequest');

export const UpdateSkillNetworkHostResponseSchema = z
  .object({ data: SkillNetworkApprovalSchema })
  .openapi('UpdateSkillNetworkHostResponse');

/** Query for removing one site from a skill's allowed or denied list. */
export const DeleteSkillNetworkHostRequestQuerySchema = z
  .object({
    host: SkillNetworkHostSchema,
  })
  .openapi('DeleteSkillNetworkHostRequestQuery');

export const DeleteSkillNetworkHostResponseSchema = z.object({}).openapi('DeleteSkillNetworkHostResponse');

export type ConfiguredSkill = z.infer<typeof ConfiguredSkillSchema>;
export type CreateSkillRequest = z.infer<typeof CreateSkillRequestSchema>;
export type UpdateSkillRequest = z.infer<typeof UpdateSkillRequestSchema>;
export type AvailableSkill = z.infer<typeof AvailableSkillSchema>;
export type SkillVersion = z.infer<typeof SkillVersionSchema>;
export type SkillNetworkApproval = z.infer<typeof SkillNetworkApprovalSchema>;
export type UpdateSkillNetworkApprovalRequest = z.infer<typeof UpdateSkillNetworkApprovalRequestSchema>;
export type UpdateSkillNetworkHostRequest = z.infer<typeof UpdateSkillNetworkHostRequestSchema>;
