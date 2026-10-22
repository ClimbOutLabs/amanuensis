// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { WelcomeScreen } from '@/atoms/WelcomeScreen.js';
import { SlotsProvider, useSlot, useThemeMode } from '@/theme/SlotsProvider.js';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider.js';

function WelcomeConsumer() {
  const SlotWelcome = useSlot('WelcomeScreen');
  return <SlotWelcome heading="hello" />;
}

function ThemeModeConsumer() {
  return <output>{useThemeMode()}</output>;
}

function CustomWelcome(_props: ComponentProps<typeof WelcomeScreen>) {
  return <p data-testid="custom-welcome">custom</p>;
}

function CustomAccordion({ children }: { children?: ReactNode }) {
  return <section data-testid="custom-accordion">{children}</section>;
}

describe('SlotsProvider', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  it('resolves the default WelcomeScreen when no override is provided', () => {
    render(<WelcomeConsumer />);
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('resolves the default atom even without a wrapping SlotsProvider', () => {
    render(<WelcomeConsumer />);
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('resolves an overridden atom when wrapped in SlotsProvider', () => {
    render(
      <SlotsProvider overrides={{ WelcomeScreen }}>
        <WelcomeConsumer />
      </SlotsProvider>,
    );
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('provides the consumer-controlled theme mode', () => {
    render(
      <SlotsProvider theme={{ mode: 'dark' }}>
        <ThemeModeConsumer />
      </SlotsProvider>,
    );

    expect(screen.getByText('dark')).toBeInTheDocument();
  });

  it('replaces the resolved atom entirely with the override, not merging it', () => {
    render(
      <SlotsProvider overrides={{ WelcomeScreen: CustomWelcome }}>
        <WelcomeConsumer />
      </SlotsProvider>,
    );
    expect(screen.getByTestId('custom-welcome')).toBeInTheDocument();
    expect(screen.queryByText('hello')).not.toBeInTheDocument();
  });

  it('nested SlotsProviders only override the slots they specify, inheriting the rest', () => {
    function AccordionConsumer() {
      const Accordion = useSlot('Accordion');
      return <Accordion>nested-ok</Accordion>;
    }

    render(
      <SlotsProvider overrides={{ WelcomeScreen: CustomWelcome }} theme={{ mode: 'dark' }}>
        <SlotsProvider overrides={{ Accordion: CustomAccordion }}>
          <WelcomeConsumer />
          <AccordionConsumer />
          <ThemeModeConsumer />
        </SlotsProvider>
      </SlotsProvider>,
    );

    expect(screen.getByTestId('custom-welcome')).toBeInTheDocument();
    expect(screen.getByTestId('custom-accordion')).toHaveTextContent('nested-ok');
    expect(screen.getByText('nested-ok')).toBeInTheDocument();
    expect(screen.getByText('dark')).toBeInTheDocument();
  });

  it('does not nest a second theme root when the host already provides one', () => {
    const { container } = render(
      <ThemeProvider theme={{ mode: 'light' }}>
        <SlotsProvider theme={{ mode: 'light' }}>
          <ThemeModeConsumer />
        </SlotsProvider>
      </ThemeProvider>,
    );

    expect(container.querySelectorAll('.aui-theme-root')).toHaveLength(1);
    expect(screen.getByText('light')).toBeInTheDocument();
  });

  it('shares one preset between host chrome and slotted content', () => {
    function PresetProbe({ testId }: { testId: string }) {
      const { preset, setPreset } = useTheme();
      return (
        <div>
          <output data-testid={testId}>{preset}</output>
          <button type="button" onClick={() => setPreset('midnight')}>
            midnight
          </button>
        </div>
      );
    }

    render(
      <ThemeProvider theme={{ mode: 'light' }}>
        {/* Host chrome outside the slotted tree, like the runtime rail. */}
        <PresetProbe testId="host-preset" />
        <SlotsProvider theme={{ mode: 'light' }}>
          <PresetProbe testId="slotted-preset" />
        </SlotsProvider>
      </ThemeProvider>,
    );

    expect(screen.getByTestId('host-preset')).toHaveTextContent('paper');
    expect(screen.getByTestId('slotted-preset')).toHaveTextContent('paper');

    act(() => {
      screen.getAllByText('midnight')[0]?.click();
    });

    // One shared context: the host chrome follows the preset change made
    // inside the slotted tree instead of keeping its mount-time preset.
    expect(screen.getByTestId('host-preset')).toHaveTextContent('midnight');
    expect(screen.getByTestId('slotted-preset')).toHaveTextContent('midnight');
  });
});
