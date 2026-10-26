// @vitest-environment jsdom
import { BugReportButton, BugReportDialog } from '@/atoms/BugReportButton.js';
import {
  BugReportProvider,
  type AppBugReportBundle,
  type BugReportApi,
  type BugReportHandoffTarget,
} from '@/components/BugReportContext.js';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act, type ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RuntimeHarness } from '../containers/RuntimeHarness.js';

const bundle: AppBugReportBundle = {
  schema_version: 1,
  generated_at: '2026-09-05T00:00:00.000Z',
  build: { version: '0.1.4' },
  user_description: '',
  config_flags: { sandbox_enabled: false, skill_enabled: false, settings_enabled: true },
  redaction: { stripped_fields: [], notes: 'structure only' },
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

const getBugReportHandoff = vi.fn<() => Promise<BugReportHandoffTarget>>();

function makeApi(): BugReportApi {
  return {
    generateBugReport: () => Promise.reject(new Error('not used')),
    generateAppBugReport: () => Promise.resolve(bundle),
    getBugReportHandoff,
  };
}

function Page({ children }: { children?: ReactNode }) {
  return (
    <RuntimeHarness messages={[]}>
      <BugReportButton />
      <BugReportDialog />
      {children}
    </RuntimeHarness>
  );
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

beforeEach(() => {
  getBugReportHandoff.mockReset();
  getBugReportHandoff.mockResolvedValue(null);
});

const openButton = () => screen.getByRole('button', { name: 'Report a bug' });

async function closeDialog() {
  const dialog = await screen.findByRole('dialog', { name: 'Report a bug' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(document.querySelector('dialog[open]')).toBeNull());
}

describe('BugReportButton and BugReportDialog', () => {
  it('render nothing without a provider', () => {
    render(<Page />);

    expect(screen.queryByRole('button', { name: 'Report a bug' })).not.toBeInTheDocument();
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('gives a fresh form when closed and opened again right away', async () => {
    render(
      <BugReportProvider api={makeApi()}>
        <Page />
      </BugReportProvider>,
    );

    fireEvent.click(openButton());
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'first note' } });
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Report a bug' })).getByRole('button', { name: 'Close' }),
    );
    fireEvent.click(openButton());

    expect(await screen.findByRole('dialog', { name: 'Report a bug' })).toHaveAttribute('open');
    expect(screen.getByRole('textbox')).toHaveValue('');
    await waitFor(() => expect(getBugReportHandoff).toHaveBeenCalledTimes(2));
  });

  it('ignores a tracker lookup that answers after the dialog was closed', async () => {
    const first = deferred<BugReportHandoffTarget>();
    const second = deferred<BugReportHandoffTarget>();
    getBugReportHandoff.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(
      <BugReportProvider api={makeApi()}>
        <Page />
      </BugReportProvider>,
    );

    fireEvent.click(openButton());
    await closeDialog();
    fireEvent.click(openButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Generate report' }));
    await screen.findByRole('button', { name: 'Download (.json)' });

    await act(async () => {
      first.resolve({ issueUrl: 'https://example.test/old' });
    });
    expect(screen.queryByRole('button', { name: 'File on GitHub' })).not.toBeInTheDocument();

    await act(async () => {
      second.resolve({ issueUrl: 'https://example.test/new' });
    });
    expect(await screen.findByRole('button', { name: 'File on GitHub' })).toBeInTheDocument();
  });

  it('looks up the tracker once per open even when the host passes a new api object each render', async () => {
    const view = render(
      <BugReportProvider api={makeApi()}>
        <Page />
      </BugReportProvider>,
    );

    fireEvent.click(openButton());
    await screen.findByRole('dialog', { name: 'Report a bug' });
    view.rerender(
      <BugReportProvider api={makeApi()}>
        <Page />
      </BugReportProvider>,
    );
    view.rerender(
      <BugReportProvider api={makeApi()}>
        <Page />
      </BugReportProvider>,
    );

    expect(getBugReportHandoff).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the button that opened it', async () => {
    render(
      <BugReportProvider api={makeApi()}>
        <Page />
      </BugReportProvider>,
    );

    fireEvent.click(openButton());
    await closeDialog();

    await waitFor(() => expect(openButton()).toHaveFocus());
  });
});
