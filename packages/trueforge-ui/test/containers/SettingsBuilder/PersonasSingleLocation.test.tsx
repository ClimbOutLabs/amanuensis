// @vitest-environment jsdom
// Bug: "Personas" used to appear twice in Settings — once as its own nav section
// (SettingsBuilder/index.tsx), and again embedded under Roles and Personas
// (ModelRoleSettings.tsx), matching docs/model-roles.mdx ("Settings ->
// Roles and Personas"). Personas now sit on that page's Personas sub-tab.
// This exercises the REAL ModelRoleSettings and PersonaSettings (unlike
// SettingsBuilder/index.test.tsx, which mocks section content) so it
// actually proves personas render in exactly one place.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DraftCatalogProvider } from '@/atoms/draft/DraftCatalogProvider.js';
import { PersonaProvider, type Persona, type PersonaApi } from '@/components/PersonaContext.js';
import TruefoundrySettingsBuilder from '@/containers/SettingsBuilder/index.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider, useShellMode } from '@/server/ShellModeContext.js';
import { personaKnowledgeApiStubs } from '../../personaApiStubs.js';
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
    ...personaKnowledgeApiStubs,
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
  it('has no standalone Personas nav item, and shows personas exactly once, on the Personas sub-tab', async () => {
    render(<TestShell />);

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument());

    // No separate "Personas" tab in the section nav.
    const sectionNav = screen.getByRole('tablist', { name: 'Settings sections' });
    expect(within(sectionNav).queryByRole('tab', { name: 'Personas' })).not.toBeInTheDocument();

    // Personas live on the Roles and Personas page. The section is lazy-loaded, and a
    // cold vitest transform of its model-selector import graph can take >5s,
    // so give the chunk load a generous budget instead of the default 5s.
    fireEvent.click(screen.getByRole('tab', { name: 'Roles and Personas' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Roles and Personas' })).toBeInTheDocument(), {
      timeout: 20000,
    });

    // The page opens on its Roles sub-tab: the role assignments show, no persona does.
    const pageTabs = screen.getByRole('tablist', { name: 'Roles and Personas sections' });
    expect(
      within(pageTabs)
        .getAllByRole('tab')
        .map(tab => tab.textContent),
    ).toEqual(['Roles', 'Personas']);
    expect(within(pageTabs).getByRole('tab', { name: 'Roles' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Main chat model' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Personas' })).not.toBeInTheDocument();

    // On the Personas sub-tab: exactly one "Personas" region, the configured
    // persona listed once, and the role assignments gone.
    fireEvent.click(within(pageTabs).getByRole('tab', { name: 'Personas' }));
    expect(await screen.findAllByText('Zara')).toHaveLength(1);
    expect(screen.getAllByRole('region', { name: 'Personas' })).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Main chat model' })).not.toBeInTheDocument();
  }, 60000);

  it('keeps a half-typed persona when switching to Roles and back', async () => {
    render(<TestShell />);

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Roles and Personas' }));
    const pageTabs = await screen.findByRole('tablist', { name: 'Roles and Personas sections' }, { timeout: 20000 });

    fireEvent.click(within(pageTabs).getByRole('tab', { name: 'Personas' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add persona' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Milo' } });

    fireEvent.click(within(pageTabs).getByRole('tab', { name: 'Roles' }));
    expect(screen.getByRole('heading', { name: 'Main chat model' })).toBeInTheDocument();
    fireEvent.click(within(pageTabs).getByRole('tab', { name: 'Personas' }));

    expect(screen.getByLabelText('Name')).toHaveValue('Milo');
  }, 60000);
});
