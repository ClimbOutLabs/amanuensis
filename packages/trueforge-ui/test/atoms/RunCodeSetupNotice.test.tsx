// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RunCodeSetupNotice } from '@/atoms/RunCodeSetupNotice.js';

const DOCKER_MISSING =
  "I can't run code on this machine because Docker isn't available. To enable code execution, install Docker from https://docs.docker.com/engine/install/ and restart Aman.";

describe('RunCodeSetupNotice', () => {
  it('announces that the code was not run with a visible label, not only a colour', () => {
    render(<RunCodeSetupNotice message={DOCKER_MISSING} />);

    const notice = screen.getByRole('status');
    expect(notice).toBeVisible();
    expect(within(notice).getByText('Code was not run')).toBeVisible();
  });

  it('shows the server text word for word', () => {
    render(<RunCodeSetupNotice message={DOCKER_MISSING} />);

    expect(screen.getByTestId('run-code-setup-notice-message').textContent).toBe(DOCKER_MISSING);
  });

  it('turns the install URL into a link that opens safely in a new tab', () => {
    render(<RunCodeSetupNotice message={DOCKER_MISSING} />);

    const link = within(screen.getByRole('status')).getByRole('link', {
      name: 'https://docs.docker.com/engine/install/',
    });
    expect(link).toHaveAttribute('href', 'https://docs.docker.com/engine/install/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('keeps the sentence punctuation that follows a URL outside the link', () => {
    render(<RunCodeSetupNotice message="See https://example.com/help." />);

    const notice = screen.getByRole('status');
    expect(within(notice).getByRole('link')).toHaveTextContent(/^https:\/\/example\.com\/help$/);
    expect(notice).toHaveTextContent('See https://example.com/help.');
  });

  it('does not link anything that is not an https URL', () => {
    render(<RunCodeSetupNotice message="Open http://example.com/a or javascript:alert(1) or ftp://example.com/b" />);

    expect(within(screen.getByRole('status')).queryAllByRole('link')).toEqual([]);
  });

  it('shows text without any URL as plain text', () => {
    render(<RunCodeSetupNotice message="The sandbox could not apply all isolation guarantees." />);

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('The sandbox could not apply all isolation guarantees.');
    expect(within(notice).queryAllByRole('link')).toEqual([]);
  });

  describe('when the sandbox is not ready', () => {
    const NOT_READY =
      "Code can't run on this computer yet. To turn it on, run `aman doctor sandbox --fix` on the computer where Aman is installed, then try again.";

    it('shows the one fix as a command that can be copied, without the quote marks', async () => {
      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      render(<RunCodeSetupNotice message={NOT_READY} />);

      expect(screen.getByTestId('run-code-setup-notice-message').textContent).toBe(NOT_READY.replaceAll('`', ''));
      expect(screen.getByTestId('run-code-setup-notice-command')).toHaveTextContent(/^aman doctor sandbox --fix$/);
      fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith('aman doctor sandbox --fix');
      });
      expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible();
    });

    it('keeps links in the text around a command', () => {
      render(<RunCodeSetupNotice message="Run `aman doctor sandbox --fix`, or see https://example.com/help." />);
      const notice = screen.getByRole('status');
      expect(within(notice).getByRole('link')).toHaveAttribute('href', 'https://example.com/help');
      expect(within(notice).getAllByTestId('run-code-setup-notice-command')).toHaveLength(1);
    });
  });
});
