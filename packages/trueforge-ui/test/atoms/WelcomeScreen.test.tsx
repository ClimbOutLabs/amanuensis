import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WelcomeScreen } from '@/atoms/WelcomeScreen.js';
import { ThemeProvider } from '@/theme/ThemeProvider.js';

describe('WelcomeScreen', () => {
  it('renders the default heading and brand icon outside a provider', () => {
    const { container } = render(<WelcomeScreen className="host-welcome" />);

    const heading = screen.getByRole('heading', { level: 1, name: 'How can I help you today?' });
    const root = container.querySelector('[data-preset="paper"]');
    expect(root).toHaveClass('aui-thread-welcome-root', 'host-welcome');
    expect(root?.querySelector('svg[role="img"]')).toBeInTheDocument();
    expect(heading).toHaveClass('font-semibold', 'delay-75');
  });

  it('renders a custom heading and icon', () => {
    render(<WelcomeScreen heading="Start a task" icon={<span aria-label="Custom welcome icon">★</span>} />);

    expect(screen.getByRole('heading', { name: 'Start a task' })).toBeInTheDocument();
    expect(screen.getByLabelText('Custom welcome icon')).toHaveTextContent('★');
  });

  it('allows callers to explicitly suppress the icon', () => {
    const { container } = render(<WelcomeScreen icon={null} />);

    const heading = screen.getByRole('heading');
    expect(container.querySelector('svg')).not.toBeInTheDocument();
    expect(heading).not.toHaveClass('delay-75');
  });

  // The provider's preset is initial state, so each preset gets its own mount.
  it('uses preset-specific icon behavior', () => {
    const highContrast = render(
      <ThemeProvider theme={{ preset: 'high-contrast', mode: 'light' }}>
        <WelcomeScreen />
      </ThemeProvider>,
    );
    expect(highContrast.container.querySelector('.aui-thread-welcome-root svg')).not.toBeInTheDocument();
    expect(screen.getByRole('heading')).toHaveClass('font-normal');
    highContrast.unmount();

    const paper = render(
      <ThemeProvider theme={{ preset: 'paper', mode: 'light' }}>
        <WelcomeScreen />
      </ThemeProvider>,
    );
    expect(paper.container.querySelector('.aui-thread-welcome-root svg[role="img"]')).toBeInTheDocument();
    expect(screen.getByRole('heading')).toHaveClass('font-semibold');
    paper.unmount();
  });
});
