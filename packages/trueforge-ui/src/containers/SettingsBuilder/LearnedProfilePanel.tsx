'use client';

import { useState, type FormEvent } from 'react';

import { Markdown } from '../../atoms/Markdown.js';
import { auiSettingsInputClass } from '../../atoms/lib/inputClasses.js';
import { Button } from '../../atoms/primitives/Button.js';
import { Switch } from '../../atoms/primitives/Switch.js';
import {
  EMPTY_PERSONALIZATION_PROFILE,
  useAssistantDisplayName,
  usePersonalization,
} from '../../components/PersonalizationContext.js';

/**
 * Settings > Memory > Learned profile: the document the host learns from conversations,
 * with the switch that lets it keep learning. Both are fields on the personalization
 * profile, so saving here writes the whole profile back with only those two fields
 * changed; every other field rides along exactly as loaded.
 */
export default function LearnedProfilePanel() {
  const assistant = useAssistantDisplayName();
  const { profile, loading, loadError, updateProfile } = usePersonalization();
  // The person's unsaved changes, undefined while untouched. What shows is the change if there
  // is one, else the loaded profile. Reading the profile at render time (rather than copying it
  // into state in an effect) means a profile that arrives just as the person clicks can never
  // overwrite the click.
  const [learnedProfileEdit, setLearnedProfileEdit] = useState<string | null | undefined>(undefined);
  const [learningEnabledEdit, setLearningEnabledEdit] = useState<boolean | undefined>(undefined);
  const learnedProfile = learnedProfileEdit === undefined ? (profile?.learned_profile ?? null) : learnedProfileEdit;
  // Undefined while the host never sent the switch and the person has not touched it: a host
  // that never sent the switch must not be sent one back.
  const learningEnabled = learningEnabledEdit ?? profile?.learning_enabled;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'error' | 'success'; message: string } | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      await updateProfile({
        ...(profile ?? EMPTY_PERSONALIZATION_PROFILE),
        learned_profile: learnedProfile !== null && learnedProfile.trim() !== '' ? learnedProfile : null,
        ...(learningEnabled === undefined ? {} : { learning_enabled: learningEnabled }),
      });
      // The provider now holds the saved profile, so the edits are folded in.
      setLearnedProfileEdit(undefined);
      setLearningEnabledEdit(undefined);
      setFeedback({ tone: 'success', message: 'Learned profile saved.' });
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not save the learned profile.',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto pb-1">
      {loadError ? (
        <p
          className="rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-sm text-failure-bg"
          role="alert"
        >
          {loadError}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-text-secondary" role="status">
          Loading personalization…
        </p>
      ) : (
        <form className="space-y-4" onSubmit={save}>
          <section className="rounded-xl border border-border bg-card-bg p-4" aria-labelledby="learned-profile-heading">
            <h4 id="learned-profile-heading" className="text-sm font-semibold text-text-primary">
              Learned profile
            </h4>
            <p className="mt-1 text-sm text-text-secondary">
              {assistant} updates this from your conversations. Edit or clear it any time.
            </p>

            <div className="mt-3 flex items-start gap-3 rounded-lg border border-border/70 bg-input-box-bg px-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text-primary">Learn from conversations</p>
                <p className="mt-0.5 text-xs leading-snug text-text-secondary">
                  When you tell {assistant} something lasting about yourself, it adds a line here. This uses the same
                  model call that saves your memories, so it adds no call of its own. When this fills up, the oldest
                  facts move to your memories and nothing is lost. You can edit or clear it any time.
                </p>
              </div>
              <Switch
                // A host that never sent the switch renders as off; it stays absent on the
                // wire until the user touches it, which is a choice worth sending.
                checked={learningEnabled ?? false}
                aria-label="Learn from conversations"
                disabled={saving}
                className="mt-0.5"
                onCheckedChange={checked => setLearningEnabledEdit(checked)}
              />
            </div>

            {learnedProfile === null ? (
              <p className="mt-3 text-sm text-text-secondary">Nothing learned yet.</p>
            ) : editing ? (
              <textarea
                id="personalization-learned-profile"
                aria-label="Learned profile document"
                className={auiSettingsInputClass('mt-3 min-h-40 resize-y font-mono')}
                value={learnedProfile}
                onChange={event => setLearnedProfileEdit(event.target.value)}
              />
            ) : (
              <div className="mt-3 rounded-md border border-border/70 bg-input-box-bg px-3 py-2.5 text-sm">
                <Markdown content={learnedProfile} readOnly />
              </div>
            )}

            {learnedProfile !== null ? (
              <div className="mt-3 flex gap-2">
                <Button type="button" variant="secondary" size="small" onClick={() => setEditing(current => !current)}>
                  {editing ? 'Preview' : 'Edit'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  onClick={() => {
                    setEditing(false);
                    setLearnedProfileEdit(null);
                  }}
                >
                  Clear learned profile
                </Button>
              </div>
            ) : null}
          </section>

          {feedback ? (
            <p
              className={feedback.tone === 'error' ? 'text-sm text-failure-bg' : 'text-sm text-success-bg'}
              role="status"
            >
              {feedback.message}
            </p>
          ) : null}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
