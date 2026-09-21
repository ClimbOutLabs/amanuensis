// @vitest-environment jsdom
// Bug: "Personas" used to appear twice in Settings — once as its own nav section
// (SettingsBuilder/index.tsx), and again embedded under Model roles
// (ModelRoleSettings.tsx), matching docs/model-roles.mdx ("Settings -> Model
// roles -> Personas"). This exercises the REAL ModelRoleSettings and
// PersonaSettings (unlike SettingsBuilder/index.test.tsx, which mocks section
// content) so it actually proves personas render in exactly one place.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DraftCatalogProvider } from '@/atoms/draft/DraftCatalogProvider.js';
import { PersonaProvider, type Persona, type PersonaApi } from '@/components/PersonaContext.js';
import TruefoundrySettingsBuilder from '@/containers/SettingsBuilder/index.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider, useShellMode } from '@/server/ShellModeContext.js';
import { createMockAgentUIServer, createMockCatalog } from '../../server/mockServer.js';

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryAgentSpec: () => ({ agentSpec: { model: { name: 'openai/gpt-4.1' } }, specError: null }),
  useTrueFoundryUpdateAgentSpec: () => vi.fn(),
}));

const personas: Persona[] = [
  { id: 'p1', display_name: 'Zara', aliases: [], instructions: 'Be Zara.', model_name: 'openai/gpt-4.1' },
];

function TestShell() {
  const personaApi: PersonaApi = {
    listPersonas: async () => personas,
    createPersona: async persona => ({ ...persona, id: 'new' }),
    updatePersona: async (_id, persona) => ({ ...persona, id: 'p1' }),
    deletePersona: async () => {},
    getSessionPersona: async () => null,
    setSessionPersona: async () => null,
  };
  return (
    <ServerProvider server={createMockAgentUIServer({ catalog: createMockCatalog(), getModels: async () => [] })}>
      <DraftCatalogProvider>
        <PersonaProvider api={personaApi}>
          <ShellModeProvider>
            <OpenSettingsButton />
            <TruefoundrySettingsBuilder />
          </ShellModeProvider>
        </PersonaProvider>
      </DraftCatalogProvider>
    </ServerProvider>
  );
}

function OpenSettingsButton() {
  const { setSettingsOpen } = useShellMode();
  return (
    <button type="button" onClick={() => setSettingsOpen(true)}>
      Open settings
    </button>
  );
}

describe('Personas render in exactly one place in Settings', () => {
  it('has no standalone Personas nav item, and shows personas exactly once, under Model roles', async () => {
    render(<TestShell />);

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument());

    // No separate "Personas" tab in the section nav.
    expect(screen.queryByRole('button', { name: 'Personas' })).not.toBeInTheDocument();

    // Personas live on the Model roles page.
    fireEvent.click(screen.getByRole('button', { name: 'Model roles' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Model roles' })).toBeInTheDocument(), {
      timeout: 5000,
    });

    // Exactly one "Personas" region, and the configured persona is listed once.
    expect(await screen.findAllByText('Zara')).toHaveLength(1);
    expect(screen.getAllByRole('region', { name: 'Personas' })).toHaveLength(1);
  });
});
