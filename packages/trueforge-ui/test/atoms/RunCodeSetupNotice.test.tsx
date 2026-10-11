// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

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
});
