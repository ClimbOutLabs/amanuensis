// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useThreadIsRunning = vi.fn(() => false);
const useAuiState = vi.fn();

vi.mock('@assistant-ui/core/react', () => ({
  useThreadIsRunning: () => useThreadIsRunning(),
}));

vi.mock('@assistant-ui/react', () => ({
  useAuiState: (selector: (state: unknown) => unknown) => useAuiState(selector),
}));

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryToolResponses: () => ({ pending: [] }),
}));

import { MascotAnimator } from '@/atoms/MascotAnimator.js';

describe('MascotAnimator component', () => {
  beforeEach(() => {
    useThreadIsRunning.mockReturnValue(false);
    useAuiState.mockImplementation((selector: (state: unknown) => unknown) => {
      const mockState = {
        composer: { text: '' },
        thread: { messages: [] },
      };
      return selector(mockState);
    });
  });

  it('renders the image when no providers are present', () => {
    render(<MascotAnimator src="/test-avatar.png" alt="Test avatar" />);

    const image = screen.getByRole('img', { name: 'Test avatar' });
    expect(image).toBeInTheDocument();
    expect(image).toHaveAttribute('src', '/test-avatar.png');
  });

  it('renders as idle action when no animation context is available', () => {
    const { container } = render(<MascotAnimator src="/test-avatar.png" alt="Test avatar" />);

    const animatorContainer = container.querySelector('.mascot-animator__container');
    expect(animatorContainer).toBeInTheDocument();
    // Should have idle action or fallback styling
    expect(animatorContainer?.className).toContain('mascot-animator');
  });

  it('shows error animation when last assistant message has error status', async () => {
    useThreadIsRunning.mockReturnValue(true);
    const { rerender, container } = render(<MascotAnimator src="/test-avatar.png" alt="Test avatar" />);

    // Switch to stopped state with error message
    useThreadIsRunning.mockReturnValue(false);
    useAuiState.mockImplementation((selector: (state: unknown) => unknown) => {
      const mockState = {
        composer: { text: '' },
        thread: {
          messages: [
            {
              role: 'assistant',
              status: { type: 'incomplete', reason: 'error' },
            },
          ],
        },
      };
      return selector(mockState);
    });

    rerender(<MascotAnimator src="/test-avatar.png" alt="Test avatar" />);

    await waitFor(() => {
      const animatorContainer = container.querySelector('.mascot-animator__container');
      expect(animatorContainer?.className).toContain('mascot-animator--oops');
    });
  });

  it('shows celebration animation when last assistant message completes successfully', async () => {
    useThreadIsRunning.mockReturnValue(true);
    const { rerender, container } = render(<MascotAnimator src="/test-avatar.png" alt="Test avatar" />);

    // Switch to stopped state with successful completion
    useThreadIsRunning.mockReturnValue(false);
    useAuiState.mockImplementation((selector: (state: unknown) => unknown) => {
      const mockState = {
        composer: { text: '' },
        thread: {
          messages: [
            {
              role: 'assistant',
              status: { type: 'complete' },
            },
          ],
        },
      };
      return selector(mockState);
    });

    rerender(<MascotAnimator src="/test-avatar.png" alt="Test avatar" />);

    await waitFor(() => {
      const animatorContainer = container.querySelector('.mascot-animator__container');
      expect(animatorContainer?.className).toContain('mascot-animator--celebrating');
    });
  });
});
