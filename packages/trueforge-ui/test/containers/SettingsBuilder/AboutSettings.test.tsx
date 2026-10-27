// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import AboutSettings from '@/containers/SettingsBuilder/AboutSettings.js';
import type { BuildIdentity } from '@/plugins/trueforge-agent-server-adapter/lists.js';

const { capabilitiesMock } = vi.hoisted(() => ({
  capabilitiesMock: { current: null as { build?: BuildIdentity } | null },
}));

vi.mock('@/server/ServerContext.js', () => ({
  useServerCapabilities: () => capabilitiesMock.current,
}));

vi.mock('@/components/PersonalizationContext.js', () => ({
  useAssistantDisplayName: () => 'Test Assistant',
}));

describe('AboutSettings', () => {
  it('shows the exact version and source reference from the build identity', () => {
    capabilitiesMock.current = { build: { version: '0.2.0-rc.8', ref: '753a3f94' } };

    render(<AboutSettings />);

    expect(screen.getByRole('heading', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByText('The version of Test Assistant running on this computer.')).toBeInTheDocument();
    expect(screen.getByText('0.2.0-rc.8')).toBeInTheDocument();
    expect(screen.getByText('753a3f94')).toBeInTheDocument();
    expect(screen.queryByText('Version not available.')).not.toBeInTheDocument();
  });

  it('shows the version without a source reference when the build has none', () => {
    capabilitiesMock.current = { build: { version: '1.4.2' } };

    render(<AboutSettings />);

    expect(screen.getByText('1.4.2')).toBeInTheDocument();
    expect(screen.queryByText('Version not available.')).not.toBeInTheDocument();
  });

  it('says the version is not available when there is no build identity', () => {
    capabilitiesMock.current = null;

    render(<AboutSettings />);

    expect(screen.getByRole('heading', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByText('Version not available.')).toBeInTheDocument();
  });

  it('says the version is not available when capabilities carry no build', () => {
    capabilitiesMock.current = {};

    render(<AboutSettings />);

    expect(screen.getByText('Version not available.')).toBeInTheDocument();
  });
});
