'use client';

import { useCallback, useEffect, useRef, useState, type FC } from 'react';

import { Button } from '@/atoms/primitives/Button.js';
import {
  usePersonas,
  type NewPersonaKnowledgeDocument,
  type PersonaKnowledgeDocument,
  type PersonaKnowledgeEmbeddingModel,
} from '@/components/PersonaContext.js';
import { Icon } from '@/icons/Icon.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';

const ACCEPTED_FILES = '.pdf,.docx,.txt,.md,.markdown';
const TERMINAL_STATUSES = new Set(['ready', 'failed']);

const STATUS_LABEL: Record<PersonaKnowledgeDocument['status'], string> = {
  pending: 'Waiting',
  parsing: 'Reading',
  indexing: 'Indexing',
  ready: 'Ready',
  failed: 'Failed',
};

const STATUS_CLASS: Record<PersonaKnowledgeDocument['status'], string> = {
  pending: 'bg-warning-bg/10 text-warning-bg border-warning-bg/30',
  parsing: 'bg-warning-bg/10 text-warning-bg border-warning-bg/30',
  indexing: 'bg-warning-bg/10 text-warning-bg border-warning-bg/30',
  ready: 'bg-success-bg/10 text-success-bg border-success-bg/30',
  failed: 'bg-failure-bg/10 text-failure-bg border-failure-bg/30',
};

type AddKind = 'upload' | 'url' | 'text';

const ADD_KINDS: { value: AddKind; label: string }[] = [
  { value: 'upload', label: 'File' },
  { value: 'url', label: 'Link' },
  { value: 'text', label: 'Text' },
];

function fileToBase64(file: File): Promise<string> {
  return file.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
    }
    return btoa(binary);
  });
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/**
 * A persona's knowledge library: documents the persona can draw on when
 * answering. Each persona's library is separate; only the active persona's
 * library is ever searched.
 */
export const PersonaKnowledgeSection: FC<{ personaId: string; personaName: string }> = ({ personaId, personaName }) => {
  const { listPersonaKnowledge, createPersonaKnowledge, deletePersonaKnowledge, getPersonaKnowledgeEmbeddingModel } =
    usePersonas();
  const [documents, setDocuments] = useState<PersonaKnowledgeDocument[]>([]);
  const [model, setModel] = useState<PersonaKnowledgeEmbeddingModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<AddKind>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshModel = useCallback(async () => {
    try {
      setModel(await getPersonaKnowledgeEmbeddingModel(personaId));
    } catch (caught: unknown) {
      setError(getErrorMessage(caught, 'Could not load the knowledge library.'));
    }
  }, [getPersonaKnowledgeEmbeddingModel, personaId]);

  const refresh = useCallback(async () => {
    try {
      const [docs, embeddingModel] = await Promise.all([
        listPersonaKnowledge(personaId),
        getPersonaKnowledgeEmbeddingModel(personaId),
      ]);
      setDocuments(docs);
      setModel(embeddingModel);
      setError(null);
    } catch (caught: unknown) {
      setError(getErrorMessage(caught, 'Could not load the knowledge library.'));
    } finally {
      setLoading(false);
    }
  }, [listPersonaKnowledge, getPersonaKnowledgeEmbeddingModel, personaId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  // While anything is still indexing, poll for progress; stop when settled.
  useEffect(() => {
    if (loading || documents.every(document => TERMINAL_STATUSES.has(document.status))) {
      return;
    }
    const timer = setTimeout(() => void refresh(), 3000);
    return () => clearTimeout(timer);
  }, [loading, documents, refresh]);

  // While the search model is still arriving, poll its status only — the
  // document list doesn't change with the download.
  useEffect(() => {
    if (model === null || (model.phase !== 'downloading' && model.phase !== 'loading')) {
      return;
    }
    const timer = setTimeout(() => void refreshModel(), 5000);
    return () => clearTimeout(timer);
  }, [model, refreshModel]);

  const resetForm = () => {
    setFile(null);
    setTitle('');
    setUrl('');
    setText('');
    setFormError(null);
    if (fileInputRef.current !== null) {
      fileInputRef.current.value = '';
    }
  };

  const submit = async () => {
    setFormError(null);
    let input: NewPersonaKnowledgeDocument;
    if (kind === 'upload') {
      if (file === null) {
        setFormError('Choose a file first — PDF, Word (.docx), plain text, or Markdown.');
        return;
      }
      setBusy(true);
      try {
        const content_base64 = await fileToBase64(file);
        input = {
          kind: 'upload',
          filename: file.name,
          content_base64,
          ...(title.trim() === '' ? {} : { title: title.trim() }),
        };
      } catch {
        setBusy(false);
        setFormError('Could not read that file. Try again.');
        return;
      }
    } else if (kind === 'url') {
      if (url.trim() === '') {
        setFormError('Paste a link first.');
        return;
      }
      input = { kind: 'url', url: url.trim(), ...(title.trim() === '' ? {} : { title: title.trim() }) };
    } else {
      if (title.trim() === '' || text.trim() === '') {
        setFormError('Give the text a title and paste the content.');
        return;
      }
      input = { kind: 'text', title: title.trim(), text };
    }
    setBusy(true);
    try {
      await createPersonaKnowledge(personaId, input);
      resetForm();
      await refresh();
    } catch (caught: unknown) {
      setFormError(getErrorMessage(caught, 'Could not add that to the library.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (documentId: string) => {
    setBusy(true);
    setError(null);
    try {
      await deletePersonaKnowledge(personaId, documentId);
      await refresh();
    } catch (caught: unknown) {
      setError(getErrorMessage(caught, 'Could not delete that document.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-border bg-card-bg p-3">
      <h6 className="text-sm font-medium text-text-primary">Knowledge</h6>
      <p className="mt-1 text-sm text-text-secondary">
        {personaName}’s private library. Documents, links, and notes added here are only ever searched when{' '}
        {personaName} is answering — other personas and the default assistant can’t see them. Indexing runs in the
        background and never blocks a chat.
      </p>

      {model !== null && model.phase !== 'ready' ? (
        <p className="mt-2 rounded-md border border-border bg-card-bg px-3 py-2 text-sm text-text-secondary">
          <Icon name="info" size="1rem" className="mr-1 inline-block align-[-0.125rem]" />
          {model.message}
        </p>
      ) : null}

      {error !== null ? (
        <p
          className="mt-2 rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-sm text-failure-bg"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-2 overflow-hidden rounded-lg border border-border">
        {loading ? (
          <p className="p-3 text-sm text-text-secondary">Loading library…</p>
        ) : documents.length === 0 ? (
          <p className="p-3 text-sm text-text-secondary">Nothing here yet. Add the first document below.</p>
        ) : (
          documents.map(document => (
            <article key={document.id} className="border-b border-border p-3 last:border-b-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text-primary">{document.title}</p>
                  <p className="mt-0.5 truncate text-xs text-text-secondary">
                    {document.source_kind === 'url' &&
                    document.source_url !== null &&
                    /^https?:\/\//i.test(document.source_url) ? (
                      <a
                        href={document.source_url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline decoration-dotted underline-offset-2"
                      >
                        {document.source_label}
                      </a>
                    ) : (
                      document.source_label
                    )}
                    {' · '}
                    {document.status === 'ready'
                      ? `${String(document.chunk_count)} passages`
                      : STATUS_LABEL[document.status]}
                    {' · '}
                    {formatDate(document.created_at)}
                  </p>
                  {document.status_message !== null && document.status_message !== '' ? (
                    <p className="mt-1 text-xs text-text-secondary">{document.status_message}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[document.status]}`}
                  >
                    {STATUS_LABEL[document.status]}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    disabled={busy}
                    onClick={() => void remove(document.id)}
                    aria-label={`Delete ${document.title}`}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </article>
          ))
        )}
      </div>

      <div className="mt-3">
        <div className="mb-2 flex gap-1" role="tablist" aria-label="Add to library">
          {ADD_KINDS.map(({ value, label }) => (
            <Button
              key={value}
              type="button"
              variant={kind === value ? 'primary' : 'secondary'}
              size="small"
              onClick={() => {
                setKind(value);
                setFormError(null);
              }}
            >
              {label}
            </Button>
          ))}
        </div>

        {kind === 'upload' ? (
          <div className="flex flex-col gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_FILES}
              onChange={event => setFile(event.target.files?.[0] ?? null)}
              className="text-sm text-text-secondary"
              aria-label="Choose a file"
            />
            <input
              type="text"
              value={title}
              onChange={event => setTitle(event.target.value)}
              placeholder="Title (optional, defaults to the file name)"
              className="rounded-md border border-border bg-card-bg px-3 py-2 text-sm text-text-primary"
            />
          </div>
        ) : null}

        {kind === 'url' ? (
          <div className="flex flex-col gap-2">
            <input
              type="url"
              value={url}
              onChange={event => setUrl(event.target.value)}
              placeholder="https://example.com/article"
              className="rounded-md border border-border bg-card-bg px-3 py-2 text-sm text-text-primary"
            />
            <input
              type="text"
              value={title}
              onChange={event => setTitle(event.target.value)}
              placeholder="Title (optional, defaults to the page title)"
              className="rounded-md border border-border bg-card-bg px-3 py-2 text-sm text-text-primary"
            />
            <p className="text-xs text-text-secondary">
              The page’s text is snapshotted when you save it — later edits to the page won’t change what {personaName}{' '}
              knows.
            </p>
          </div>
        ) : null}

        {kind === 'text' ? (
          <div className="flex flex-col gap-2">
            <input
              type="text"
              value={title}
              onChange={event => setTitle(event.target.value)}
              placeholder="Title"
              className="rounded-md border border-border bg-card-bg px-3 py-2 text-sm text-text-primary"
            />
            <textarea
              value={text}
              onChange={event => setText(event.target.value)}
              placeholder="Paste text here…"
              rows={4}
              className="rounded-md border border-border bg-card-bg px-3 py-2 text-sm text-text-primary"
            />
          </div>
        ) : null}

        {formError !== null ? (
          <p
            className="mt-2 rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-sm text-failure-bg"
            role="alert"
          >
            {formError}
          </p>
        ) : null}

        <div className="mt-2">
          <Button type="button" variant="secondary" size="small" disabled={busy} onClick={() => void submit()}>
            <Icon name="plus" size="1rem" className="mr-1" />
            Add to library
          </Button>
        </div>
      </div>
    </div>
  );
};
