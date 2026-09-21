/**
 * Maps trueforge-ui skill-settings calls onto Harness
 *
 * UI: `repoURL` / skill `id` / optional `catalogId`.
 * Harness: `url` / resource `name` (no separate id or catalogId on wire).
 * For now UI `id = name`; registry link uses `catalogId = name` when the
 * configured skill's manifest (url/path/ref) still matches a catalog preset
 * of the same name. Name alone is not enough: a GitHub import can reuse a
 * catalog preset's name while pointing at a different repo, and that must
 * still go through the destructive-delete confirmation, not the registry
 * disable path.
 */
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { DefinedSkill, SkillCatalogEntry, SkillCatalogServer, SkillConfigBase } from '../../../server/types.js';

/** Manifest fields that must match a catalog entry for a configured skill to count as that preset. */
type CatalogGitFields = Pick<TrueForgeApi.CatalogSkill, 'url' | 'path' | 'ref'>;

function sameGitFields(manifest: TrueForgeApi.SkillManifest, entry: CatalogGitFields): boolean {
  if (manifest.type !== 'git') {
    return false;
  }
  return manifest.url === entry.url && (manifest.path ?? '') === (entry.path ?? '') && manifest.ref === entry.ref;
}

/** Deleting a skill row is a local DB write; it never needs the SDK's full 60s default. */
const DELETE_SKILL_TIMEOUT_SECONDS = 15;

export type UiSkill = DefinedSkill;
export type UiSkillCatalogEntry = SkillCatalogEntry;

export function toUiCatalogEntry(skill: TrueForgeApi.CatalogSkill): UiSkillCatalogEntry {
  return {
    id: skill.name,
    name: skill.name,
    description: skill.description,
    repoURL: skill.url,
    path: skill.path ?? '',
    ref: skill.ref,
  };
}

export function toHarnessManifest(req: SkillConfigBase): TrueForgeApi.settings.CreateSkillRequest['manifest'] {
  const path = req.path.trim();
  return {
    type: 'git',
    name: req.name,
    url: req.repoURL,
    ...(path === '' ? {} : { path }),
    ref: req.ref,
    description: req.description,
  };
}

export function toUiSkill(
  skill: TrueForgeApi.ConfiguredSkill,
  catalogByName: ReadonlyMap<string, CatalogGitFields>,
): UiSkill {
  const manifest = skill.manifest;
  const displayName =
    'displayName' in manifest && typeof manifest.displayName === 'string' ? manifest.displayName : manifest.name;
  const base = {
    id: skill.name,
    name: displayName,
    description: manifest.description,
  };
  const catalogEntry = catalogByName.get(skill.name);
  if (catalogEntry !== undefined && sameGitFields(skill.manifest, catalogEntry)) {
    return { ...base, catalogId: skill.name };
  }
  return base;
}

/** Settings skill-catalog port for `createTrueFoundryServer`. */
export function createSkillCatalog(client: TrueForge): SkillCatalogServer<UiSkill> {
  return {
    getSkillCatalog: async () => {
      const body = await client.catalogs.skills.list();
      return body.data.map(toUiCatalogEntry);
    },
    listSkills: async req => {
      const [listed, catalog] = await Promise.all([client.settings.skills.list(), client.catalogs.skills.list()]);
      const catalogByName = new Map(catalog.data.map(entry => [entry.name, entry]));
      const skills = listed.data.map(skill => toUiSkill(skill, catalogByName));
      const query = req?.query?.trim().toLowerCase();
      if (query === undefined || query === '') {
        return skills;
      }
      return skills.filter(
        skill => skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query),
      );
    },
    createSkill: async req => {
      const body = await client.settings.skills.create({ manifest: toHarnessManifest(req) });
      const catalogId = 'catalogId' in req ? req.catalogId : undefined;
      if (catalogId !== undefined) {
        return {
          id: body.data.name,
          name: body.data.name,
          description: body.data.manifest.description,
          catalogId,
        };
      }
      return {
        id: body.data.name,
        name: body.data.name,
        description: body.data.manifest.description,
      };
    },
    deleteSkill: async ({ id }) => {
      // Deleting a skill row is a local DB write; it never needs the SDK's full 60s default.
      // maxRetries: 0 makes the timeout bound real; see connectorCatalog.ts's deleteConnector
      // for the same reasoning, including why the SDK's default retry policy would otherwise
      // hold Settings in a "deleting…" state well past the timeout.
      await client.settings.skills.delete(id, {
        timeoutInSeconds: DELETE_SKILL_TIMEOUT_SECONDS,
        maxRetries: 0,
      });
    },
  };
}
