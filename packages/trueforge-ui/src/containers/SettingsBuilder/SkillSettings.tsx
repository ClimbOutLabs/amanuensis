'use client';

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { Button } from '@/atoms/primitives/Button.js';
import { CenteredModal } from '@/atoms/primitives/CenteredModal.js';
import SearchInput from '@/atoms/primitives/SearchInput.js';
import { Icon } from '@/icons/Icon.js';
import { useCatalogServer } from '../../server/ServerContext.js';
import {
  hasSkillNetworkApproval,
  skillNetworkApprovalLines,
  skillNetworkApprovedLine,
  type SkillNetworkApprovalState,
} from '../../server/skillNetworkApproval.js';
import type { RegistrySkill, SkillBase, SkillCatalogEntry, SkillConfigBase } from '../../server/types.js';
import { getErrorMessage } from '../../utils/getErrorMessage.js';
import { useToasterOptional } from '../ToasterContainer.js';
import ImportGithubSkillForm from './ImportGithubSkillForm.js';

const matchesQuery = (query: string, name: string, description: string) =>
  !query || name.toLowerCase().includes(query) || description.toLowerCase().includes(query);

const isRegistrySkill = (skill: SkillBase): skill is RegistrySkill => 'catalogId' in skill;

function isManagedSkillError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'statusCode') === 424;
}

const SkillSettings = () => {
  const { skillCatalog } = useCatalogServer();
  const toaster = useToasterOptional();

  const [query, setQuery] = useState('');
  const [skills, setSkills] = useState<SkillBase[]>([]);
  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [managedExternally, setManagedExternally] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // A git-imported skill is deleted outright, so removing it goes through a confirm dialog.
  // A registry (catalog) skill's Remove is a disable that just returns it to Available.
  const [pendingRemoval, setPendingRemoval] = useState<SkillBase | null>(null);
  // Network approval state per enabled skill, keyed by skill id. A skill with no entry (the
  // catalog carries no approval calls, or the read failed) simply shows no panel.
  const [networkApprovals, setNetworkApprovals] = useState<Record<string, SkillNetworkApprovalState>>({});
  // Skills whose approval prompt the person closed with "Don't allow" in this view. Nothing is
  // stored for that choice: the skill just stays without network access.
  const [dismissedNetworkPrompts, setDismissedNetworkPrompts] = useState<ReadonlySet<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!skillCatalog) return;
    setLoading(true);
    setError(null);
    try {
      const [defined, available] = await Promise.all([skillCatalog.listSkills(), skillCatalog.getSkillCatalog()]);
      setSkills(defined);
      setCatalog(available);
      if (hasSkillNetworkApproval(skillCatalog)) {
        const approvals = await Promise.all(
          defined.map(async skill => {
            try {
              return [skill.id, await skillCatalog.getSkillNetworkApproval({ id: skill.id })] as const;
            } catch {
              return undefined;
            }
          }),
        );
        setNetworkApprovals(Object.fromEntries(approvals.filter(entry => entry !== undefined)));
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load skills'));
    } finally {
      setLoading(false);
    }
  }, [skillCatalog]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const normalizedQuery = query.trim().toLowerCase();

  const selectedSkills = useMemo(
    () => skills.filter(skill => matchesQuery(normalizedQuery, skill.name, skill.description)),
    [skills, normalizedQuery],
  );

  const availableSkills = useMemo(() => {
    const selectedCatalogIds = new Set(skills.flatMap(skill => (isRegistrySkill(skill) ? [skill.catalogId] : [])));
    return catalog.filter(
      entry => !selectedCatalogIds.has(entry.id) && matchesQuery(normalizedQuery, entry.name, entry.description),
    );
  }, [catalog, skills, normalizedQuery]);

  const runMutation = async (fn: () => Promise<void>, setMutationError = setError) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      if (isManagedSkillError(err)) setManagedExternally(true);
      setMutationError(getErrorMessage(err, 'Request failed'));
      throw err;
    } finally {
      setBusy(false);
    }
  };

  if (!skillCatalog) {
    return <p className="text-sm text-text-secondary">Could not load the skills catalog. Try again.</p>;
  }

  const handleSelect = (entry: SkillCatalogEntry) => {
    void runMutation(async () => {
      await skillCatalog.createSkill({
        catalogId: entry.id,
        name: entry.name,
        description: entry.description,
        repoURL: entry.repoURL,
        path: entry.path,
        ref: entry.ref,
      });
    }).catch(() => {});
  };

  const handleRemove = (skill: SkillBase) => {
    const deleteSkill = skillCatalog.deleteSkill;
    if (!deleteSkill) return;
    void runMutation(async () => {
      await deleteSkill({ id: skill.id });
    }).catch(() => {});
  };

  const handleRemoveClick = (skill: SkillBase) => {
    if (isRegistrySkill(skill)) {
      // Built-in catalog presets already have a disable path: Remove just returns them
      // to Available, so it does not need a confirmation step.
      handleRemove(skill);
      return;
    }
    setPendingRemoval(skill);
  };

  const confirmRemove = () => {
    const skill = pendingRemoval;
    setPendingRemoval(null);
    if (skill) handleRemove(skill);
  };

  const handleImport = async (draft: SkillConfigBase) => {
    setFormError(null);
    await runMutation(async () => {
      await skillCatalog.createSkill(draft);
    }, setFormError);
    setTimeout(() => {
      toaster?.showSuccess({ title: `${draft.name} imported` });
    }, 0);
  };

  const handleAllowNetwork = (skill: SkillBase, state: SkillNetworkApprovalState) => {
    if (!hasSkillNetworkApproval(skillCatalog)) return;
    void runMutation(async () => {
      await skillCatalog.approveSkillNetwork({ id: skill.id, hosts: [...state.declaredHosts] });
    }).catch(() => {});
  };

  const handleRevokeNetwork = (skill: SkillBase) => {
    if (!hasSkillNetworkApproval(skillCatalog)) return;
    void runMutation(async () => {
      await skillCatalog.revokeSkillNetwork({ id: skill.id });
    }).catch(() => {});
  };

  const renderNetworkPanel = (skill: SkillBase): ReactNode => {
    const state = networkApprovals[skill.id];
    if (state === undefined || state.declaredHosts.length === 0) {
      return null;
    }
    const hostsList = (
      <ul className="mt-2 flex flex-col gap-0.5">
        {state.declaredHosts.map(host => (
          <li key={host} className="font-mono text-[0.8125rem] text-text-primary">
            {host}
          </li>
        ))}
      </ul>
    );
    if (state.approvedHosts !== null) {
      return (
        <div className="border-b border-border bg-secondary-bg/50 px-3 py-3 last:border-b-0">
          <p className="text-sm text-text-secondary">{skillNetworkApprovedLine()}</p>
          {hostsList}
          <div className="mt-3">
            <Button.Secondary
              size="small"
              type="button"
              disabled={busy || managedExternally}
              onClick={() => {
                handleRevokeNetwork(skill);
              }}
            >
              Remove network access
            </Button.Secondary>
          </div>
        </div>
      );
    }
    if (dismissedNetworkPrompts.has(skill.id)) {
      return (
        <div className="flex items-center gap-3 border-b border-border bg-secondary-bg/50 px-3 py-3 last:border-b-0">
          <p className="min-w-0 flex-1 text-sm text-text-secondary">Network access is off for this skill.</p>
          <Button.Secondary
            size="small"
            type="button"
            disabled={busy || managedExternally}
            onClick={() => {
              setDismissedNetworkPrompts(current => {
                const next = new Set(current);
                next.delete(skill.id);
                return next;
              });
            }}
          >
            Review the sites
          </Button.Secondary>
        </div>
      );
    }
    const lines = skillNetworkApprovalLines({ skillName: skill.name, state });
    return (
      <div className="border-b border-border bg-secondary-bg/50 px-3 py-3 last:border-b-0">
        <p className="text-sm text-text-primary">{lines[0]}</p>
        {hostsList}
        {lines.slice(1).map(line => (
          <p key={line} className="mt-2 text-sm text-text-secondary">
            {line}
          </p>
        ))}
        <div className="mt-3 flex gap-2">
          <Button.Primary
            size="small"
            type="button"
            disabled={busy || managedExternally}
            onClick={() => {
              handleAllowNetwork(skill, state);
            }}
          >
            Allow
          </Button.Primary>
          <Button.Secondary
            size="small"
            type="button"
            disabled={busy || managedExternally}
            onClick={() => {
              setDismissedNetworkPrompts(current => new Set(current).add(skill.id));
            }}
          >
            Don’t allow
          </Button.Secondary>
        </div>
      </div>
    );
  };

  const renderRow = ({
    key,
    name,
    description,
    action,
  }: {
    key: string;
    name: string;
    description: string;
    action: ReactNode;
  }) => (
    <article key={key} className="flex min-h-16 items-center gap-3 border-b border-border p-3 last:border-b-0">
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary-bg"
        aria-hidden
      >
        <Icon name="lightbulb" className="size-4.5 text-text-primary" />
      </span>

      <div className="min-w-0 flex-1">
        <h5 className="truncate text-sm font-medium text-text-primary">{name}</h5>
        {description ? <p className="mt-0.5 truncate text-sm text-text-secondary">{description}</p> : null}
      </div>

      {action}
    </article>
  );

  const hasMatches = selectedSkills.length > 0 || availableSkills.length > 0;

  return (
    <>
      <h3 className="text-xl font-semibold tracking-tight text-text-primary">Skills</h3>
      <p className="mt-1 text-sm text-text-secondary">Use built-in skills or import custom skills from GitHub.</p>

      {error ? (
        <p className="mt-3 rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-sm text-failure-bg">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="min-w-0 flex-1">
            <SearchInput query={query} setQuery={setQuery} placeholder="Search skills" />
          </div>
          <Button.Secondary
            type="button"
            className="shrink-0"
            disabled={busy || managedExternally}
            onClick={() => {
              setFormError(null);
              setImportOpen(true);
            }}
          >
            <Icon name="github" className="size-4" />
            Import from GitHub
          </Button.Secondary>
        </div>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto pb-1">
          {loading ? <p className="py-8 text-center text-sm text-text-secondary">Loading…</p> : null}

          {!loading && selectedSkills.length > 0 ? (
            <section aria-labelledby="enabled-skills-heading">
              <h4
                id="enabled-skills-heading"
                className="mb-2 text-[0.8125rem] font-semibold uppercase text-text-secondary"
              >
                Enabled · {selectedSkills.length}
              </h4>
              <div className="overflow-hidden rounded-xl border border-border bg-card-bg">
                {selectedSkills.map(skill => (
                  <Fragment key={skill.id}>
                    {renderRow({
                      key: skill.id,
                      name: skill.name,
                      description: skill.description,
                      action: skillCatalog.deleteSkill ? (
                        <Button.Secondary
                          size="small"
                          type="button"
                          disabled={busy || managedExternally}
                          aria-label={`Remove ${skill.name}`}
                          onClick={() => {
                            handleRemoveClick(skill);
                          }}
                        >
                          Remove
                        </Button.Secondary>
                      ) : null,
                    })}
                    {renderNetworkPanel(skill)}
                  </Fragment>
                ))}
              </div>
            </section>
          ) : null}

          {!loading && availableSkills.length > 0 ? (
            <section aria-labelledby="available-skills-heading">
              <h4
                id="available-skills-heading"
                className="mb-2 text-[0.8125rem] font-semibold uppercase text-text-secondary"
              >
                Available · {availableSkills.length}
              </h4>
              <div className="overflow-hidden rounded-xl border border-border bg-card-bg">
                {availableSkills.map(entry =>
                  renderRow({
                    key: entry.id,
                    name: entry.name,
                    description: entry.description,
                    action: (
                      <Button.Secondary
                        size="small"
                        type="button"
                        disabled={busy || managedExternally}
                        aria-label={`Enable ${entry.name}`}
                        onClick={() => {
                          handleSelect(entry);
                        }}
                      >
                        Enable
                      </Button.Secondary>
                    ),
                  }),
                )}
              </div>
            </section>
          ) : null}

          {!loading && !hasMatches ? (
            <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-border p-8 text-center text-sm text-text-secondary">
              {normalizedQuery ? `No skills match “${query.trim()}”.` : 'No skills yet.'}
            </div>
          ) : null}
        </div>
      </div>

      <ImportGithubSkillForm
        open={importOpen}
        onOpenChange={open => {
          setImportOpen(open);
          if (!open) setFormError(null);
        }}
        onImport={handleImport}
        busy={busy || managedExternally}
        error={formError}
      />

      <CenteredModal
        open={pendingRemoval !== null}
        onOpenChange={open => {
          if (!open) setPendingRemoval(null);
        }}
        title={`Remove ${pendingRemoval?.name ?? 'skill'}?`}
        contentSized
        className="md:max-w-md"
      >
        <div className="px-5 py-5">
          <p className="text-sm text-text-secondary">
            This removes the imported skill. You can re-import it from GitHub later.
          </p>
        </div>
        <footer className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <Button variant="ghost" type="button" onClick={() => setPendingRemoval(null)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" type="button" disabled={busy} onClick={confirmRemove}>
            Remove skill
          </Button>
        </footer>
      </CenteredModal>
    </>
  );
};

export default SkillSettings;
