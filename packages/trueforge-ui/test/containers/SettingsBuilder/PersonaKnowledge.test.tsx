// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  PersonaProvider,
  type NewPersonaKnowledgeDocument,
  type PersonaApi,
  type PersonaKnowledgeDocument,
  type PersonaKnowledgeEmbeddingModel,
} from '@/components/PersonaContext.js';
import { PersonaKnowledgeSection } from '@/containers/SettingsBuilder/PersonaKnowledge.js';

const DOC: PersonaKnowledgeDocument = {
  id: 'doc-1',
  title: 'Exit story',
  title_explicit: true,
  source_kind: 'text',
  source_label: 'Pasted text',
  source_url: null,
  status: 'ready',
  status_message: null,
  chunk_count: 7,
  created_at: '2026-09-22T10:00:00.000Z',
  updated_at: '2026-09-22T10:01:00.000Z',
};

const READY_MODEL: PersonaKnowledgeEmbeddingModel = {
  phase: 'ready',
  message: 'Ready — new documents become searchable as soon as they finish indexing.',
};

function renderSection(overrides?: {
  listPersonaKnowledge?: PersonaApi['listPersonaKnowledge'];
  createPersonaKnowledge?: PersonaApi['createPersonaKnowledge'];
  deletePersonaKnowledge?: PersonaApi['deletePersonaKnowledge'];
  getPersonaKnowledgeEmbeddingModel?: PersonaApi['getPersonaKnowledgeEmbeddingModel'];
}) {
  const api: PersonaApi = {
    listPersonas: async () => [],
    createPersona: async () => {
      throw new Error('not used');
    },
    updatePersona: async () => {
      throw new Error('not used');
    },
    deletePersona: async () => {},
    getSessionPersona: async () => null,
    setSessionPersona: async () => null,
    listPersonaKnowledge: overrides?.listPersonaKnowledge ?? (async () => []),
    createPersonaKnowledge:
      overrides?.createPersonaKnowledge ??
      (async () => {
        throw new Error('not used');
      }),
    deletePersonaKnowledge: overrides?.deletePersonaKnowledge ?? (async () => {}),
    getPersonaKnowledgeEmbeddingModel: overrides?.getPersonaKnowledgeEmbeddingModel ?? (async () => READY_MODEL),
  };
  return render(
    <PersonaProvider api={api}>
      <PersonaKnowledgeSection personaId="p-zara" personaName="Zara" />
    </PersonaProvider>,
  );
}

describe('PersonaKnowledgeSection', () => {
  it('explains the empty library and its cross-persona isolation', async () => {
    renderSection();
    expect(await screen.findByText(/Nothing here yet/)).toBeInTheDocument();
    expect(screen.getByText(/other personas and the default assistant can’t see them/)).toBeInTheDocument();
  });

  it('lists documents with status, passage count, and a working delete', async () => {
    let docs = [DOC];
    const deletePersonaKnowledge = vi.fn(async (_personaId: string, documentId: string) => {
      docs = docs.filter(document => document.id !== documentId);
    });
    renderSection({
      listPersonaKnowledge: async () => [...docs],
      deletePersonaKnowledge,
    });

    expect(await screen.findByText('Exit story')).toBeInTheDocument();
    expect(screen.getByText(/Pasted text/)).toBeInTheDocument();
    expect(screen.getByText(/7 passages/)).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Exit story' }));
    expect(deletePersonaKnowledge).toHaveBeenCalledWith('p-zara', 'doc-1');
    await waitFor(() => expect(screen.getByText(/Nothing here yet/)).toBeInTheDocument());
  });

  it('adds pasted text with a title', async () => {
    const created: NewPersonaKnowledgeDocument[] = [];
    renderSection({
      createPersonaKnowledge: async (_personaId, input) => {
        created.push(input);
        return { ...DOC, id: 'doc-2', title: 'New note' };
      },
    });
    await screen.findByText(/Nothing here yet/);

    fireEvent.click(screen.getByRole('button', { name: 'Text' }));
    fireEvent.change(screen.getByPlaceholderText('Title'), { target: { value: 'New note' } });
    fireEvent.change(screen.getByPlaceholderText(/Paste text here/), {
      target: { value: 'The solo project sold for twenty million dollars.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual({
      kind: 'text',
      title: 'New note',
      text: 'The solo project sold for twenty million dollars.',
    });
  });

  it('requires a title and content before adding text', async () => {
    const createPersonaKnowledge = vi.fn();
    renderSection({ createPersonaKnowledge });
    await screen.findByText(/Nothing here yet/);

    fireEvent.click(screen.getByRole('button', { name: 'Text' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));

    expect(await screen.findByText(/Give the text a title and paste the content/)).toBeInTheDocument();
    expect(createPersonaKnowledge).not.toHaveBeenCalled();
  });

  it('shows the search-model state in plain English while it downloads', async () => {
    renderSection({
      getPersonaKnowledgeEmbeddingModel: async () => ({
        phase: 'downloading',
        message: 'Downloading the search model (about 120 MB, one time only).',
      }),
    });
    expect(await screen.findByText(/Downloading the search model/)).toBeInTheDocument();
  });

  it('surfaces a failed document’s plain-English reason', async () => {
    renderSection({
      listPersonaKnowledge: async () => [
        { ...DOC, id: 'doc-9', status: 'failed', status_message: 'No readable text was found.' },
      ],
    });
    expect(await screen.findByText('No readable text was found.')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('renders a saved link as a link, but never a non-http(s) URL', async () => {
    renderSection({
      listPersonaKnowledge: async () => [
        {
          ...DOC,
          id: 'doc-http',
          source_kind: 'url',
          source_label: 'example.com',
          source_url: 'https://example.com/story',
        },
        // A legacy or hostile row must not become a clickable javascript: href.
        { ...DOC, id: 'doc-evil', source_kind: 'url', source_label: 'evil', source_url: 'javascript:alert(1)' },
      ],
    });
    const httpLink = await screen.findByRole('link', { name: 'example.com' });
    expect(httpLink).toHaveAttribute('href', 'https://example.com/story');
    // The hostile row renders its label as inert text: no anchor anywhere may
    // carry a javascript: href, and the label still shows.
    const anchors = Array.from(document.querySelectorAll('a'));
    expect(anchors.some(a => (a.getAttribute('href') ?? '').startsWith('javascript:'))).toBe(false);
    expect(screen.getByText(/evil ·/)).toBeInTheDocument();
  });
});
