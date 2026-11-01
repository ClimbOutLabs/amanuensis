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

const FULL_REF = '2b0c78362b09f5e2388fcfed7c95d63f4228c9cb';

describe('AboutSettings', () => {
  it('shows the version and build as labeled rows, the build shortened with the full value on its title', () => {
    capabilitiesMock.current = { build: { version: '0.2.0-rc.8', ref: FULL_REF } };

    render(<AboutSettings />);

    expect(screen.getByRole('heading', { name: 'About' })).toBeInTheDocument();
    expect(screen.queryByText(/running on this computer/)).not.toBeInTheDocument();
    expect(screen.getByText('Version')).toBeInTheDocument();
    expect(screen.getByText('0.2.0-rc.8')).toBeInTheDocument();
    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.getByText('2b0c7836')).toBeInTheDocument();
    expect(screen.queryByText(FULL_REF)).not.toBeInTheDocument();
    expect(screen.getByTitle(FULL_REF)).toHaveTextContent('2b0c7836');
    expect(screen.queryByText('Version not available.')).not.toBeInTheDocument();
  });

  it('shows the version row without a build row when the build has no source reference', () => {
    capabilitiesMock.current = { build: { version: '1.4.2' } };

    render(<AboutSettings />);

    expect(screen.getByText('Version')).toBeInTheDocument();
    expect(screen.getByText('1.4.2')).toBeInTheDocument();
    expect(screen.queryByText('Build')).not.toBeInTheDocument();
    expect(screen.queryByText('Version not available.')).not.toBeInTheDocument();
  });

  it('says the version is not available when there is no build identity', () => {
    capabilitiesMock.current = null;

    render(<AboutSettings />);

    expect(screen.getByRole('heading', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByText('Version not available.')).toBeInTheDocument();
    expect(screen.queryByText('Build')).not.toBeInTheDocument();
  });

  it('says the version is not available when capabilities carry no build', () => {
    capabilitiesMock.current = {};

    render(<AboutSettings />);

    expect(screen.getByText('Version not available.')).toBeInTheDocument();
  });
});
