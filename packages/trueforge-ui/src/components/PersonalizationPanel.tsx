'use client';

import { useEffect, useRef, useState, type FC, type FormEvent } from 'react';

import { Markdown } from '../atoms/Markdown.js';
import { Button } from '../atoms/primitives/Button.js';
import { Switch } from '../atoms/primitives/Switch.js';
import {
  EMPTY_PERSONALIZATION_PROFILE,
  PersonalizationProvider,
  usePersonalization,
  type PersonalizationApi,
  type PersonalizationProfile,
} from './PersonalizationContext.js';

const inputClassName =
  'w-full rounded-md border border-border/70 bg-secondary-bg px-3 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary/70 focus-visible:border-focus-ring focus-visible:ring-2 focus-visible:ring-focus-ring/50';

export type PersonalizationPanelProps = {
  /** Optional for standalone use; Settings inherits the host provider. */
  api?: PersonalizationApi;
  onProfileChange?: (profile: PersonalizationProfile | null) => void;
};

const PersonalizationPanelContent: FC<Pick<PersonalizationPanelProps, 'onProfileChange'>> = ({ onProfileChange }) => {
  const { profile, loading, loadError, updateProfile, deleteProfile } = usePersonalization();
  const [draft, setDraft] = useState<PersonalizationProfile>(profile ?? EMPTY_PERSONALIZATION_PROFILE);
  const [saving, setSaving] = useState(false);
  const [editingLearned, setEditingLearned] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'error' | 'success'; message: string } | null>(null);

  // Pinned preferences are plain strings on the wire, with no id of their own. React needs a key
  // that stays put while a row's text changes, so each row gets one here, assigned by position
  // and never derived from the text or the index — a text-derived key changes on every keystroke,
  // which remounts the row's <input> (a fresh DOM node) and drops focus mid-word.
  const nextPreferenceId = useRef(0);
  const [preferenceIds, setPreferenceIds] = useState<number[]>(() =>
    (profile ?? EMPTY_PERSONALIZATION_PROFILE).pinned_preferences.map(() => nextPreferenceId.current++),
  );

  // `onProfileChange` is a public prop and commonly supplied as an inline handler, which gets a
  // fresh identity on every render of the parent. Reading it through a ref kept current here
  // (rather than depending on it directly below) means the resync effect only re-runs when
  // `profile` itself changes — a callback-identity-only render must not regenerate the row ids
  // and remount every preference input mid-edit.
  const onProfileChangeRef = useRef(onProfileChange);
  onProfileChangeRef.current = onProfileChange;

  useEffect(() => {
    const nextProfile = profile ?? EMPTY_PERSONALIZATION_PROFILE;
    setDraft(nextProfile);
    setPreferenceIds(nextProfile.pinned_preferences.map(() => nextPreferenceId.current++));
    onProfileChangeRef.current?.(profile);
  }, [profile]);

  const updateDraft = (
    field: keyof Omit<PersonalizationProfile, 'pinned_preferences' | 'learning_enabled'>,
    value: string,
  ) => {
    setDraft(current => ({ ...current, [field]: value.trim() === '' ? null : value }));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const next = await updateProfile({
        ...draft,
        pinned_preferences: draft.pinned_preferences.map(item => item.trim()).filter(Boolean),
        learned_profile:
          draft.learned_profile !== null && draft.learned_profile.trim() !== '' ? draft.learned_profile : null,
      });
      setDraft(next);
      setFeedback({ tone: 'success', message: 'Personalization saved.' });
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not save personalization.',
      });
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      await deleteProfile();
      setDraft(EMPTY_PERSONALIZATION_PROFILE);
      setFeedback({ tone: 'success', message: 'Personalization cleared.' });
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not clear personalization.',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h3 className="text-xl font-semibold tracking-tight text-text-primary">Personalization</h3>
      <p className="mt-1 text-sm text-text-secondary">Shape Aman's identity, voice, and what it remembers about you.</p>

      {loadError ? (
        <p
          className="mt-3 rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-sm text-failure-bg"
          role="alert"
        >
          {loadError}
        </p>
      ) : null}

      <div className="mt-4 flex-1 overflow-y-auto pb-4">
        {loading ? (
          <p className="text-sm text-text-secondary" role="status">
            Loading personalization…
          </p>
        ) : (
          <form className="space-y-4" onSubmit={save}>
            <section
              className="rounded-xl border border-border bg-card-bg p-4"
              aria-labelledby="assistant-profile-heading"
            >
              <h4 id="assistant-profile-heading" className="text-sm font-semibold text-text-primary">
                Assistant profile
              </h4>
              <p className="mt-1 text-sm text-text-secondary">Choose how Aman sees itself and speaks with you.</p>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div>
                  <label
                    htmlFor="personalization-assistant-name"
                    className="mb-1.5 block text-sm font-medium text-text-primary"
                  >
                    Name
                  </label>
                  <input
                    id="personalization-assistant-name"
                    className={inputClassName}
                    value={draft.assistant_name ?? ''}
                    onChange={event => updateDraft('assistant_name', event.target.value)}
                    placeholder="Aman"
                  />
                </div>
                <div>
                  <label htmlFor="personalization-voice" className="mb-1.5 block text-sm font-medium text-text-primary">
                    Voice guidance
                  </label>
                  <input
                    id="personalization-voice"
                    className={inputClassName}
                    value={draft.voice_guidance ?? ''}
                    onChange={event => updateDraft('voice_guidance', event.target.value)}
                    placeholder="Warm, direct, concise…"
                  />
                </div>
              </div>

              <div className="mt-4">
                <label
                  htmlFor="personalization-identity"
                  className="mb-1.5 block text-sm font-medium text-text-primary"
                >
                  Identity
                </label>
                <textarea
                  id="personalization-identity"
                  className={`${inputClassName} min-h-24 resize-y`}
                  value={draft.assistant_identity ?? ''}
                  onChange={event => updateDraft('assistant_identity', event.target.value)}
                  placeholder="How should it understand its role?"
                />
              </div>
            </section>

            <section className="rounded-xl border border-border bg-card-bg p-4" aria-labelledby="user-context-heading">
              <h4 id="user-context-heading" className="text-sm font-semibold text-text-primary">
                About you
              </h4>
              <p className="mt-1 text-sm text-text-secondary">Add background that helps Aman work with you.</p>

              <div className="mt-4">
                <label
                  htmlFor="personalization-user-profile"
                  className="mb-1.5 block text-sm font-medium text-text-primary"
                >
                  Your profile
                </label>
                <textarea
                  id="personalization-user-profile"
                  className={`${inputClassName} min-h-24 resize-y`}
                  value={draft.user_profile ?? ''}
                  onChange={event => updateDraft('user_profile', event.target.value)}
                  placeholder="Useful context about you"
                />
              </div>

              <fieldset className="mt-4 min-w-0 border-0 p-0">
                <legend className="text-sm font-medium text-text-primary">Pinned preferences</legend>
                <p className="mt-1 text-sm text-text-secondary">Key preferences, kept visible and easy to edit.</p>
                <div className="mt-3 space-y-2">
                  {draft.pinned_preferences.map((preference, index) => (
                    <div className="flex flex-col gap-2 sm:flex-row" key={preferenceIds[index] ?? index}>
                      <input
                        className={inputClassName}
                        aria-label={`Pinned preference ${index + 1}`}
                        value={preference}
                        onChange={event => {
                          const nextValue = event.target.value;
                          setDraft(current => ({
                            ...current,
                            pinned_preferences: current.pinned_preferences.map((item, itemIndex) =>
                              itemIndex === index ? nextValue : item,
                            ),
                          }));
                        }}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        className="sm:self-center"
                        aria-label={`Remove pinned preference ${index + 1}`}
                        onClick={() => {
                          setDraft(current => ({
                            ...current,
                            pinned_preferences: current.pinned_preferences.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          }));
                          setPreferenceIds(current => current.filter((_, itemIndex) => itemIndex !== index));
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  className="mt-3"
                  disabled={draft.pinned_preferences.length >= 12}
                  onClick={() => {
                    setDraft(current => ({ ...current, pinned_preferences: [...current.pinned_preferences, ''] }));
                    setPreferenceIds(current => [...current, nextPreferenceId.current++]);
                  }}
                >
                  + Add preference
                </Button>
              </fieldset>
            </section>

            <section
              className="rounded-xl border border-border bg-card-bg p-4"
              aria-labelledby="learned-profile-heading"
            >
              <h4 id="learned-profile-heading" className="text-sm font-semibold text-text-primary">
                Learned profile
              </h4>
              <p className="mt-1 text-sm text-text-secondary">
                Aman updates this from your conversations. Edit or clear it any time.
              </p>

              <div className="mt-3 flex items-start gap-3 rounded-lg border border-border/70 bg-secondary-bg px-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">Learn from conversations</p>
                  <p className="mt-0.5 text-xs leading-snug text-text-secondary">
                    After a conversation, a local model updates this document from it, at most once an hour. You can
                    edit or clear it any time.
                  </p>
                </div>
                <Switch
                  // A host that never sent the switch renders as off; it stays absent on the
                  // wire until the user touches it, which is a choice worth sending.
                  checked={draft.learning_enabled ?? false}
                  aria-label="Learn from conversations"
                  disabled={saving}
                  className="mt-0.5"
                  onCheckedChange={checked => setDraft(current => ({ ...current, learning_enabled: checked }))}
                />
              </div>

              {draft.learned_profile === null ? (
                <p className="mt-3 text-sm text-text-secondary">Nothing learned yet.</p>
              ) : editingLearned ? (
                <textarea
                  id="personalization-learned-profile"
                  aria-label="Learned profile document"
                  className={`${inputClassName} mt-3 min-h-40 resize-y font-mono`}
                  value={draft.learned_profile}
                  onChange={event => setDraft(current => ({ ...current, learned_profile: event.target.value }))}
                />
              ) : (
                <div className="mt-3 rounded-md border border-border/70 bg-secondary-bg px-3 py-2.5 text-sm">
                  <Markdown content={draft.learned_profile} readOnly />
                </div>
              )}

              {draft.learned_profile !== null ? (
                <div className="mt-3 flex gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    onClick={() => setEditingLearned(current => !current)}
                  >
                    {editingLearned ? 'Preview' : 'Edit'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    onClick={() => {
                      setEditingLearned(false);
                      setDraft(current => ({ ...current, learned_profile: null }));
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
              <Button type="button" variant="ghost" onClick={() => void clear()} disabled={saving}>
                Clear all
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save personalization'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </>
  );
};

/** Settings-native editor for the host-provided personalization profile. */
export const PersonalizationPanel: FC<PersonalizationPanelProps> = ({ api, onProfileChange }) => {
  if (api) {
    return (
      <PersonalizationProvider api={api}>
        <PersonalizationPanelContent onProfileChange={onProfileChange} />
      </PersonalizationProvider>
    );
  }
  return <PersonalizationPanelContent onProfileChange={onProfileChange} />;
};

export type { PersonalizationApi, PersonalizationProfile } from './PersonalizationContext.js';
