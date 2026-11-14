// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import ImportGithubSkillForm from '@/containers/SettingsBuilder/ImportGithubSkillForm.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
});

describe('ImportGithubSkillForm', () => {
  it('submits the complete create skill request', async () => {
    const onImport = vi.fn(async () => undefined);

    render(<ImportGithubSkillForm open onOpenChange={() => undefined} onImport={onImport} />);

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: ' Release notes ' },
    });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: ' Generate release notes ' },
    });
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: ' https://github.com/org/repo ' },
    });
    fireEvent.change(screen.getByLabelText('Folder containing the SKILL.md'), {
      target: { value: ' skills/release-notes ' },
    });
    fireEvent.change(screen.getByLabelText('Branch'), {
      target: { value: ' main ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(onImport).toHaveBeenCalledWith({
        name: 'Release notes',
        description: 'Generate release notes',
        repoURL: 'https://github.com/org/repo',
        path: 'skills/release-notes',
        ref: 'main',
      });
    });
  });
});

describe('ImportGithubSkillForm with a website check', () => {
  const check = {
    commit: 'a'.repeat(40),
    websites: ['api.news-digest.info'],
    makesUpAddresses: true,
    canSend: false,
  };

  function fill() {
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'news' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Reads the news' } });
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://github.com/org/news' } });
    fireEvent.change(screen.getByLabelText('Folder containing the SKILL.md'), { target: { value: 'skills/news' } });
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'main' } });
  }

  it('shows the websites first, and adding allows exactly those', async () => {
    const onImport = vi.fn(async () => undefined);
    const onCheck = vi.fn(async () => check);
    render(<ImportGithubSkillForm open onOpenChange={() => undefined} onImport={onImport} onCheck={onCheck} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Check skill' }));

    await screen.findByText('It sends requests to these websites:');
    expect(onCheck).toHaveBeenCalledWith({ repoURL: 'https://github.com/org/news', path: 'skills/news', ref: 'main' });
    expect(screen.getByRole('listitem')).toHaveTextContent('api.news-digest.info');
    expect(screen.getByText(/The skill can send any of your data to them/)).toBeInTheDocument();
    expect(screen.getByText(/makes up web addresses while it runs/)).toBeInTheDocument();
    expect(onImport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Add skill and allow websites' }));
    await waitFor(() => {
      expect(onImport).toHaveBeenCalledWith(
        {
          name: 'news',
          description: 'Reads the news',
          repoURL: 'https://github.com/org/news',
          path: 'skills/news',
          ref: 'main',
        },
        ['api.news-digest.info'],
      );
    });
  });

  it('checks again after the address, folder or branch changes', async () => {
    const onCheck = vi.fn(async () => check);
    render(<ImportGithubSkillForm open onOpenChange={() => undefined} onImport={vi.fn()} onCheck={onCheck} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Check skill' }));
    await screen.findByRole('button', { name: 'Add skill and allow websites' });

    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'next' } });
    expect(screen.getByRole('button', { name: 'Check skill' })).toBeInTheDocument();
    expect(screen.queryByText('It sends requests to these websites:')).toBeNull();
  });

  it('shows why the check failed, and adds nothing', async () => {
    const onImport = vi.fn(async () => undefined);
    const onCheck = vi.fn(async () => {
      throw new Error("Aman could not read this skill's files to check which websites it uses.");
    });
    render(<ImportGithubSkillForm open onOpenChange={() => undefined} onImport={onImport} onCheck={onCheck} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Check skill' }));
    await screen.findByText(/could not read this skill's files/);
    expect(onImport).not.toHaveBeenCalled();
  });
});
