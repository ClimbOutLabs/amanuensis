'use client';

import { useEffect, useState, type FC, type FormEvent } from 'react';

import { useDraftCatalog } from '@/atoms/draft/DraftCatalogProvider.js';
import { displayModelLabel } from '@/atoms/draft/DraftModelCatalogPanel.js';
import { Button } from '@/atoms/primitives/Button.js';
import { EMPTY_PERSONA_DRAFT, usePersonas, type Persona, type PersonaDraft } from '@/components/PersonaContext.js';
import { Icon } from '@/icons/Icon.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';
import { PersonaKnowledgeSection } from './PersonaKnowledge.js';

const inputClassName =
  'w-full rounded-md border border-border/70 bg-secondary-bg px-3 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary/70 focus-visible:border-focus-ring focus-visible:ring-2 focus-visible:ring-focus-ring/50';

function toDraft(persona: Persona): PersonaDraft {
  return {
    display_name: persona.display_name,
    aliases: persona.aliases,
    instructions: persona.instructions,
    model_name: persona.model_name,
  };
}

/** Aliases are edited as one comma-separated line; the server owns uniqueness. */
function parseAliases(value: string): string[] {
  return value
    .split(',')
    .map(alias => alias.trim())
    .filter(alias => alias.length > 0);
}

type PersonaFormProps = {
  draft: PersonaDraft;
  aliasesText: string;
  busy: boolean;
  submitLabel: string;
  models: { name: string }[];
  onChange: (draft: PersonaDraft) => void;
  onAliasesTextChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
};

const PersonaForm: FC<PersonaFormProps> = ({
  draft,
  aliasesText,
  busy,
  submitLabel,
  models,
  onChange,
  onAliasesTextChange,
  onSubmit,
  onCancel,
}) => {
  const modelNames =
    draft.model_name && !models.some(model => model.name === draft.model_name)
      ? [...models.map(model => model.name), draft.model_name]
      : models.map(model => model.name);

  return (
    <form className="space-y-3 border-t border-border p-3" onSubmit={onSubmit}>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label htmlFor="persona-display-name" className="mb-1.5 block text-sm font-medium text-text-primary">
            Name
          </label>
          <input
            id="persona-display-name"
            className={inputClassName}
            value={draft.display_name}
            placeholder="Zara"
            onChange={event => onChange({ ...draft, display_name: event.target.value })}
          />
          <p className="mt-1 text-xs text-text-secondary">Type “Zara, …” to talk to them for the rest of the chat.</p>
        </div>
        <div>
          <label htmlFor="persona-aliases" className="mb-1.5 block text-sm font-medium text-text-primary">
            Also answers to
          </label>
          <input
            id="persona-aliases"
            className={inputClassName}
            value={aliasesText}
            placeholder="Z, Zara Quinn"
            onChange={event => onAliasesTextChange(event.target.value)}
          />
          <p className="mt-1 text-xs text-text-secondary">Comma-separated. Each name must be unique.</p>
        </div>
      </div>

      <div>
        <label htmlFor="persona-model" className="mb-1.5 block text-sm font-medium text-text-primary">
          Model
        </label>
        <select
          id="persona-model"
          className={inputClassName}
          value={draft.model_name}
          onChange={event => onChange({ ...draft, model_name: event.target.value })}
        >
          <option value="">Select a model</option>
          {modelNames.map(name => (
            <option key={name} value={name}>
              {displayModelLabel(name)}
              {models.some(model => model.name === name) ? '' : ' (unavailable)'}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="persona-instructions" className="mb-1.5 block text-sm font-medium text-text-primary">
          Role
        </label>
        <textarea
          id="persona-instructions"
          className={inputClassName}
          rows={4}
          value={draft.instructions}
          placeholder="How this persona should answer."
          onChange={event => onChange({ ...draft, instructions: event.target.value })}
        />
        <p className="mt-1 text-xs text-text-secondary">
          Shapes how this persona answers. It cannot change your tools, approvals, or safety rules.
        </p>
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={busy || draft.model_name === ''}>
          {submitLabel}
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
};

/**
 * Personas are edited here rather than written into prompt text, so the model
 * a persona answers on is a real, inspectable assignment and not something
 * buried in an instruction.
 */
const PersonaSettings = () => {
  const { personas, loading, loadError, createPersona, updatePersona, deletePersona } = usePersonas();
  const { models, ensureLoaded } = useDraftCatalog();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<PersonaDraft>(EMPTY_PERSONA_DRAFT);
  const [aliasesText, setAliasesText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [knowledgeOpenId, setKnowledgeOpenId] = useState<string | null>(null);

  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);

  const closeForm = () => {
    setAdding(false);
    setEditingId(null);
    setDraft(EMPTY_PERSONA_DRAFT);
    setAliasesText('');
    setError(null);
  };

  const openAdd = () => {
    setEditingId(null);
    setAdding(true);
    setDraft({ ...EMPTY_PERSONA_DRAFT, model_name: models[0]?.name ?? '' });
    setAliasesText('');
    setError(null);
  };

  useEffect(() => {
    const firstModel = models[0];
    if (!adding || draft.model_name !== '' || firstModel === undefined) {
      return;
    }
    setDraft(current => (current.model_name === '' ? { ...current, model_name: firstModel.name } : current));
  }, [adding, draft.model_name, models]);

  const openEdit = (persona: Persona) => {
    setAdding(false);
    setEditingId(persona.id);
    setDraft(toDraft(persona));
    setAliasesText(persona.aliases.join(', '));
    setError(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const payload: PersonaDraft = { ...draft, aliases: parseAliases(aliasesText) };
    setBusy(true);
    setError(null);
    void (editingId === null ? createPersona(payload) : updatePersona(editingId, payload))
      .then(closeForm)
      .catch((caught: unknown) => setError(getErrorMessage(caught, 'Could not save persona.')))
      .finally(() => setBusy(false));
  };

  const remove = (persona: Persona) => {
    setBusy(true);
    setError(null);
    void deletePersona(persona.id)
      .catch((caught: unknown) => setError(getErrorMessage(caught, 'Could not delete persona.')))
      .finally(() => setBusy(false));
  };

  return (
    <section aria-labelledby="personas-heading" className="mt-6">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div id="personas-heading" className="text-[0.8125rem] font-semibold uppercase text-text-secondary">
          Personas
        </div>
        <Button type="button" variant="secondary" size="small" disabled={busy || adding} onClick={openAdd}>
          <Icon name="plus" size="1rem" className="mr-1" />
          Add persona
        </Button>
      </div>
      <p className="mb-2 text-sm text-text-secondary">
        Mention a persona by name (“Zara, …”) and the rest of that chat answers as Zara, on Zara’s model, with the same
        history. Using the name in ordinary prose does not switch.
      </p>

      {(loadError ?? error) ? (
        <p
          className="mb-2 rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-sm text-failure-bg"
          role="alert"
        >
          {loadError ?? error}
        </p>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-border bg-card-bg">
        {loading ? <p className="p-3 text-sm text-text-secondary">Loading personas…</p> : null}

        {!loading && personas.length === 0 && !adding ? (
          <p className="p-3 text-sm text-text-secondary">No personas yet.</p>
        ) : null}

        {personas.map(persona => {
          const known = models.some(model => model.name === persona.model_name);
          return (
            <article key={persona.id} className="border-b border-border last:border-b-0">
              <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <h5 className="text-sm font-medium text-text-primary">{persona.display_name}</h5>
                  <p className="mt-0.5 text-sm text-text-secondary">
                    {persona.aliases.length > 0 ? `Also: ${persona.aliases.join(', ')} · ` : ''}
                    <span className={known ? undefined : 'text-failure-bg'}>
                      {displayModelLabel(persona.model_name)}
                      {known ? '' : ' — not in the current model catalog'}
                    </span>
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    disabled={busy}
                    onClick={() => setKnowledgeOpenId(current => (current === persona.id ? null : persona.id))}
                    aria-expanded={knowledgeOpenId === persona.id}
                    aria-label={`Knowledge library for ${persona.display_name}`}
                  >
                    Knowledge
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    disabled={busy}
                    onClick={() => openEdit(persona)}
                    aria-label={`Edit ${persona.display_name}`}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    disabled={busy}
                    onClick={() => remove(persona)}
                    aria-label={`Delete ${persona.display_name}`}
                  >
                    Delete
                  </Button>
                </div>
              </div>
              {knowledgeOpenId === persona.id ? (
                <div className="px-3 pb-3">
                  <PersonaKnowledgeSection personaId={persona.id} personaName={persona.display_name} />
                </div>
              ) : null}
              {editingId === persona.id ? (
                <PersonaForm
                  draft={draft}
                  aliasesText={aliasesText}
                  busy={busy}
                  submitLabel="Save persona"
                  models={models}
                  onChange={setDraft}
                  onAliasesTextChange={setAliasesText}
                  onSubmit={submit}
                  onCancel={closeForm}
                />
              ) : null}
            </article>
          );
        })}

        {adding ? (
          <PersonaForm
            draft={draft}
            aliasesText={aliasesText}
            busy={busy}
            submitLabel="Create persona"
            models={models}
            onChange={setDraft}
            onAliasesTextChange={setAliasesText}
            onSubmit={submit}
            onCancel={closeForm}
          />
        ) : null}
      </div>
    </section>
  );
};

export default PersonaSettings;
