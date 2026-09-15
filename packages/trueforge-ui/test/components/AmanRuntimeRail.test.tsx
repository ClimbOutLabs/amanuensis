import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AmanRuntimeRail } from '@/components/AmanRuntimeRail.js';
import { PersonalizationProvider } from '@/components/PersonalizationContext.js';
import type { AgentSpec } from '@/server/types.js';

import { RuntimeHarness } from '../containers/RuntimeHarness.js';

let agentSpec: AgentSpec | null | undefined;
const updateAgentSpec = vi.fn();

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryAgentSpec: () => ({ agentSpec }),
  useTrueFoundryUpdateAgentSpec: () => updateAgentSpec,
}));

describe('AmanRuntimeRail', () => {
  beforeEach(() => {
    agentSpec = undefined;
    updateAgentSpec.mockClear();
  });

  it('shows the assistant identity and runtime summary', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail avatarSrc="/aman-avatar.png" modelName="local-model" />
      </RuntimeHarness>,
    );

    expect(screen.getByRole('complementary', { name: 'Amanuensis runtime status' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Amanuensis' })).toBeInTheDocument();
    expect(screen.getByText('local-model')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Amanuensis avatar' })).toHaveAttribute('src', '/aman-avatar.png');
  });

  it('shows the version and a shortened build reference', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail version="0.4.2" buildRef="4f2a91c8d3b7e6510a2c9f4b8d1e7a3c5b6d8e90" />
      </RuntimeHarness>,
    );

    expect(screen.getByText('Build')).toBeInTheDocument();
    const value = screen.getByText('0.4.2 · 4f2a91c');
    expect(value).toBeInTheDocument();
    expect(value).toHaveAttribute('title', '0.4.2 · 4f2a91c8d3b7e6510a2c9f4b8d1e7a3c5b6d8e90');
  });

  it('leaves a tag-shaped build reference whole', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail version="0.4.2" buildRef="v0.4.2-rc1" />
      </RuntimeHarness>,
    );

    expect(screen.getByText('0.4.2 · v0.4.2-rc1')).toBeInTheDocument();
  });

  it('shows the version alone when the build carries no reference', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail version="0.4.2" />
      </RuntimeHarness>,
    );

    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.getByText('0.4.2')).toBeInTheDocument();
  });

  it('leaves out the build row when the server reports no version', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail buildRef="4f2a91c8d3b7e6510a2c9f4b8d1e7a3c5b6d8e90" />
      </RuntimeHarness>,
    );

    expect(screen.queryByText('Build')).not.toBeInTheDocument();
  });

  it('shows the memory bank in use', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail memoryBank={{ name: 'amantest', connected: true }} />
      </RuntimeHarness>,
    );

    expect(screen.getByText('Memory')).toBeInTheDocument();
    expect(screen.getByText('amantest · on')).toBeInTheDocument();
  });

  it('shows the memory recall switch checked by default', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail memoryBank={{ name: 'amantest', connected: true }} />
      </RuntimeHarness>,
    );

    expect(screen.getByRole('checkbox', { name: 'Toggle memory recall' })).toBeChecked();
  });

  it('calls updateAgentSpec with memory.recallEnabled false when the switch is clicked', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail memoryBank={{ name: 'amantest', connected: true }} />
      </RuntimeHarness>,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Toggle memory recall' }));

    expect(updateAgentSpec).toHaveBeenCalledWith({
      config: {
        memory: {
          recallEnabled: false,
        },
      },
    });
  });

  it('says a bank that still needs sign-in is not on, and links to settings', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail memoryBank={{ name: 'amantest', connected: false }} settingsHref="/settings" />
      </RuntimeHarness>,
    );

    expect(screen.getByText(/amantest · needs sign-in/)).toBeInTheDocument();
    expect(screen.queryByText('amantest · on')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'sign in' })).toHaveAttribute('href', '/settings');
  });

  it('says memory is off and links to settings when no bank is configured', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail memoryBank={null} settingsHref="/settings" />
      </RuntimeHarness>,
    );

    expect(screen.getByText('Memory')).toBeInTheDocument();
    expect(screen.getByText(/^Off/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'set up' })).toHaveAttribute('href', '/settings');
  });

  it('leaves the memory row out when the host could not find out', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail />
      </RuntimeHarness>,
    );

    expect(screen.queryByText('Memory')).not.toBeInTheDocument();
  });

  it('renders an accessible fallback when no avatar is configured', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail status="offline" />
      </RuntimeHarness>,
    );

    expect(screen.getByRole('img', { name: 'Amanuensis avatar' })).toHaveTextContent('A');
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('shows the personalized name without exposing editing controls in the runtime rail', async () => {
    render(
      <RuntimeHarness messages={[]}>
        <PersonalizationProvider
          api={{
            getProfile: async () => ({
              assistant_name: 'Mira',
              assistant_identity: null,
              voice_guidance: null,
              user_profile: null,
              pinned_preferences: [],
              learned_profile: null,
            }),
            updateProfile: async profile => profile,
            deleteProfile: async () => {},
          }}
        >
          <AmanRuntimeRail />
        </PersonalizationProvider>
      </RuntimeHarness>,
    );

    expect(await screen.findByRole('heading', { name: 'Mira' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Personalize assistant' })).not.toBeInTheDocument();
  });

  it('renders the avatar as a plain, static image with no animator wrapper classes', () => {
    render(
      <RuntimeHarness messages={[]}>
        <AmanRuntimeRail avatarSrc="/aman-avatar.png" />
      </RuntimeHarness>,
    );

    const avatar = screen.getByRole('img', { name: 'Amanuensis avatar' });
    expect(avatar.tagName).toBe('IMG');
    expect(avatar.className).not.toMatch(/mascot-animator/);
    expect(avatar.parentElement?.querySelector('.mascot-animator__container')).toBeNull();
    expect(avatar.parentElement?.querySelector('.mascot-animator__halo')).toBeNull();
  });
});
