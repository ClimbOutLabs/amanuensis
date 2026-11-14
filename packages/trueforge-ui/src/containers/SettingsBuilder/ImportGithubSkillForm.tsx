'use client';

import { useState, type SyntheticEvent } from 'react';

import { auiInputClass } from '@/atoms/lib/inputClasses.js';
import { Button } from '@/atoms/primitives/Button.js';
import { CenteredModal } from '@/atoms/primitives/CenteredModal.js';
import { Icon } from '@/icons/Icon.js';
import type { SkillWebsiteCheck } from '../../server/skillNetworkApproval.js';
import type { SkillConfigBase } from '../../server/types.js';
import { addSkillLabel, SkillWebsitesReview } from './SkillWebsitesReview.js';

type ImportGithubSkillFormProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Adds the skill; `approvedWebsites` is the list the person saw, when the websites were checked. */
  onImport: (draft: SkillConfigBase, approvedWebsites?: string[]) => void | Promise<void>;
  /**
   * Checks which websites the skill sends requests to. When given, the form shows them before
   * anything is added, and adding allows exactly those.
   */
  onCheck?: (source: { repoURL: string; path: string; ref: string }) => Promise<SkillWebsiteCheck>;
  busy?: boolean;
  error?: string | null;
};

const ImportGithubSkillForm = ({
  open,
  onOpenChange,
  onImport,
  onCheck,
  busy = false,
  error,
}: ImportGithubSkillFormProps) => {
  const [check, setCheck] = useState<SkillWebsiteCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repoURL, setRepoURL] = useState('');
  const [path, setPath] = useState('');
  const [ref, setRef] = useState('');

  const reset = () => {
    setCheck(null);
    setCheckError(null);
    setName('');
    setDescription('');
    setRepoURL('');
    setPath('');
    setRef('');
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const handleSubmit = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    if (!name.trim() || !description.trim() || !repoURL.trim() || !path.trim() || !ref.trim() || busy || checking) {
      return;
    }
    const draft = {
      name: name.trim(),
      description: description.trim(),
      repoURL: repoURL.trim(),
      path: path.trim(),
      ref: ref.trim(),
    };
    if (onCheck !== undefined && check === null) {
      setChecking(true);
      setCheckError(null);
      try {
        setCheck(await onCheck({ repoURL: draft.repoURL, path: draft.path, ref: draft.ref }));
      } catch (err) {
        setCheckError(err instanceof Error ? err.message : 'The skill could not be checked. Try again.');
      } finally {
        setChecking(false);
      }
      return;
    }

    try {
      await (check === null ? onImport(draft) : onImport(draft, check.websites));
      close();
    } catch {
      // Parent surfaces error; keep form open.
    }
  };

  // Changing where the skill is means its websites must be checked again.
  const edited = (set: (value: string) => void) => (value: string) => {
    set(value);
    setCheck(null);
  };

  const canImport =
    Boolean(name.trim() && description.trim() && repoURL.trim() && path.trim() && ref.trim()) && !busy && !checking;
  const submitLabel = onCheck === undefined ? 'Import' : check === null ? 'Check skill' : addSkillLabel(check);

  return (
    <CenteredModal
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) close();
      }}
      title="Import from GitHub"
      description="Find the repo and the folder holding the SKILL.md file."
      headerIcon={
        <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary-bg text-text-primary">
          <Icon name="github" className="size-5" />
        </span>
      }
      contentSized
      className="md:max-w-2xl"
    >
      <form onSubmit={e => void handleSubmit(e)}>
        <div className="space-y-5 px-5 py-5 md:px-6">
          <div>
            <label htmlFor="skill-name" className="mb-2 block text-sm font-semibold text-text-primary">
              Name
            </label>
            <input
              id="skill-name"
              value={name}
              onChange={event => {
                setName(event.target.value);
              }}
              placeholder="release-notes"
              autoFocus
              required
              className={auiInputClass('h-11')}
            />
          </div>

          <div>
            <label htmlFor="skill-description" className="mb-2 block text-sm font-semibold text-text-primary">
              Description
            </label>
            <textarea
              id="skill-description"
              value={description}
              onChange={event => {
                setDescription(event.target.value);
              }}
              placeholder="Generate release notes from merged pull requests"
              required
              rows={3}
              className={auiInputClass('resize-y py-2.5')}
            />
          </div>

          <div>
            <label htmlFor="skill-repo-url" className="mb-2 block text-sm font-semibold text-text-primary">
              Repository URL
            </label>
            <input
              id="skill-repo-url"
              type="url"
              value={repoURL}
              onChange={event => {
                edited(setRepoURL)(event.target.value);
              }}
              placeholder="https://github.com/org/repo"
              required
              className={auiInputClass('h-11')}
            />
          </div>

          <div>
            <label htmlFor="skill-path" className="mb-2 block text-sm font-semibold text-text-primary">
              Folder containing the SKILL.md
            </label>
            <input
              id="skill-path"
              value={path}
              onChange={event => {
                edited(setPath)(event.target.value);
              }}
              placeholder="skills/release-notes"
              required
              className={auiInputClass('h-11')}
            />
          </div>

          <div>
            <label htmlFor="skill-ref" className="mb-2 block text-sm font-semibold text-text-primary">
              Branch
            </label>
            <input
              id="skill-ref"
              value={ref}
              onChange={event => {
                edited(setRef)(event.target.value);
              }}
              placeholder="main"
              required
              className={auiInputClass('h-11')}
            />
          </div>

          {check !== null ? <SkillWebsitesReview check={check} /> : null}

          <div className="space-y-3">
            {checkError ? <p className="text-failure-bg text-sm">{checkError}</p> : null}
            {error ? <p className="text-failure-bg text-sm">{error}</p> : null}
            <Button.Primary type="submit" disabled={!canImport} className="w-full">
              {checking ? 'Checking the skill…' : submitLabel}
            </Button.Primary>
          </div>
        </div>
      </form>
    </CenteredModal>
  );
};

export default ImportGithubSkillForm;
