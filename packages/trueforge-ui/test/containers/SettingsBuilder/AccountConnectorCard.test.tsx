// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AccountConnectorCard from '@/containers/SettingsBuilder/AccountConnectorCard.js';

afterEach(cleanup);

function renderCard(overrides: Partial<React.ComponentProps<typeof AccountConnectorCard>> = {}) {
  const onOpen = vi.fn();
  const onRetry = vi.fn();
  render(
    <AccountConnectorCard
      id="calendar"
      title="Calendar"
      glyph="31"
      description="Look at your calendar."
      connectedLine="Connected as owner@example.invalid."
      stoppedLine="Sign-in stopped working. Make a new app password and save it again."
      notWorkingLine="Your calendar server could not be reached. Check your internet connection, then open Manage."
      failedLabel="Couldn't check calendar right now"
      state="not_connected"
      failed={false}
      onOpen={onOpen}
      onRetry={onRetry}
      {...overrides}
    />,
  );
  return { onOpen, onRetry };
}

describe('AccountConnectorCard', () => {
  it('shows Available with the description and a Connect button that opens the panel', () => {
    const { onOpen } = renderCard();
    expect(screen.getByText('Available')).toBeTruthy();
    expect(screen.getByText('Look at your calendar.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows who it is connected as, with a Manage button', () => {
    renderCard({ state: 'connected' });
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('Connected as owner@example.invalid.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy();
  });

  it('says plainly when the saved sign-in stopped working', () => {
    renderCard({ state: 'sign_in_stopped' });
    expect(screen.getByText('Sign-in stopped working')).toBeTruthy();
    expect(screen.getByText('Sign-in stopped working. Make a new app password and save it again.')).toBeTruthy();
  });

  it('says plainly when the saved account cannot be reached right now, and offers Manage', () => {
    renderCard({ state: 'not_working' });
    expect(screen.getByText('Not working right now')).toBeTruthy();
    expect(screen.getByText(/could not be reached\. Check your internet connection/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy();
  });

  it('offers Manage for a stopped sign-in too, so the account can be changed or removed', () => {
    renderCard({ state: 'sign_in_stopped' });
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy();
  });

  it('offers Try again instead of the panel when the status could not be read', () => {
    const { onOpen, onRetry } = renderCard({ failed: true });
    expect(screen.getByText("Couldn't check calendar right now")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
