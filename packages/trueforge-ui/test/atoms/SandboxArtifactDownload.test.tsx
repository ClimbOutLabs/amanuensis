// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Markdown } from '@/atoms/Markdown.js';
import { parseSandboxArtifacts, SandboxArtifactDownload } from '@/atoms/SandboxArtifactDownload.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';
import { ThemeProvider } from '@/theme/ThemeProvider.js';

// parseSandboxArtifacts's own parsing rules are covered where the implementation now lives:
// packages/trueforge-core/tests/core/sandbox/sandboxArtifacts.test.ts. This file re-exports it
// (see SandboxArtifactDownload.tsx), so one smoke test here is enough to prove the re-export works.
describe('parseSandboxArtifacts re-export', () => {
  it('parses a markdown-link pair', () => {
    expect(parseSandboxArtifacts('[sample.js](/tmp/sample.js)')).toEqual([
      { name: 'sample.js', path: '/tmp/sample.js' },
    ]);
  });
});

describe('SandboxArtifactDownload', () => {
  it('renders download links for link-format artifacts', () => {
    const onDownload = vi.fn(async () => {});
    render(<SandboxArtifactDownload code={'[hello.js](/tmp/hello.js)'} onDownloadArtifact={onDownload} />);
    expect(screen.getByRole('link', { name: /Download hello\.js/i })).toBeInTheDocument();
    expect(screen.getByText('1 file generated')).toBeInTheDocument();
  });

  it('shows a loader while the download is in flight', async () => {
    let resolveDownload!: () => void;
    const onDownload = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveDownload = resolve;
        }),
    );
    render(<SandboxArtifactDownload code={'[hello.js](/tmp/hello.js)'} onDownloadArtifact={onDownload} />);

    await act(async () => {
      screen.getByRole('link', { name: /Download hello\.js/i }).click();
    });
    expect(screen.getByRole('link', { name: /Downloading hello\.js/i })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();

    await act(async () => {
      resolveDownload();
      await Promise.resolve();
    });
    expect(screen.getByRole('link', { name: /Download hello\.js/i })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();
  });

  it('renders the raw block text when the fence body does not parse', () => {
    render(<SandboxArtifactDownload code={'not an artifact'} />);
    expect(screen.getByTestId('aui-sandbox-artifacts-raw')).toHaveTextContent('not an artifact');
  });

  it('parses a bare absolute path line and renders a download link', () => {
    const onDownload = vi.fn(async () => {});
    render(<SandboxArtifactDownload code={'/opt/tf/workspace/tribute.mp4'} onDownloadArtifact={onDownload} />);
    expect(screen.getByRole('link', { name: /Download tribute\.mp4/i })).toBeInTheDocument();
  });
});

describe('Markdown sandbox_artifacts fence', () => {
  it('routes the fence to SandboxArtifactDownload', () => {
    render(
      <ThemeProvider>
        <SlotsProvider>
          <Markdown
            content={['Files ready:', '', '```sandbox_artifacts', '[demo.js](/tmp/demo.js)', '```'].join('\n')}
          />
        </SlotsProvider>
      </ThemeProvider>,
    );
    expect(screen.getByTestId('aui-sandbox-artifacts')).toBeInTheDocument();
    expect(screen.getByText('demo.js')).toBeInTheDocument();
  });
});
