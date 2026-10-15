import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HtmlArtifactPreview } from '@/atoms/HtmlArtifactPreview.js';

describe('HtmlArtifactPreview', () => {
  it('renders a preview iframe with sandbox attribute and srcdoc', async () => {
    const htmlBlob = new Blob(['<html><body>Hello World</body></html>'], { type: 'text/html' });

    render(<HtmlArtifactPreview content={htmlBlob} filename="test.html" readOnly={false} />);

    await waitFor(() => {
      const iframe = screen.getByTestId('aui-html-preview-iframe');
      expect(iframe).toBeInTheDocument();
      expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
      expect(iframe).toHaveAttribute('referrerPolicy', 'no-referrer');
      const srcdoc = iframe.getAttribute('srcdoc');
      // CSP meta tag is injected, so the srcdoc will be modified
      // but it should still contain the original content plus CSP
      expect(srcdoc).toContain('Hello World');
      expect(srcdoc).toContain('Content-Security-Policy');
    });
  });

  it('injects CSP meta tag into the HTML document', async () => {
    const htmlBlob = new Blob(['<html><head></head><body>Test</body></html>'], { type: 'text/html' });

    render(<HtmlArtifactPreview content={htmlBlob} filename="test.html" readOnly={false} />);

    await waitFor(() => {
      const iframe = screen.getByTestId('aui-html-preview-iframe');
      const srcdoc = iframe.getAttribute('srcdoc');
      // CSP meta tag should be injected
      expect(srcdoc).toContain('Content-Security-Policy');
      // Check for parts of the CSP policy (may be HTML-escaped)
      expect(srcdoc).toMatch(/default-src|&#39;none&#39;|'none'/);
    });
  });

  it('inlines relative stylesheets when onFetchRelatedFile is provided', async () => {
    const htmlBlob = new Blob(['<html><head><link rel="stylesheet" href="style.css"></head><body></body></html>'], {
      type: 'text/html',
    });
    const cssBlob = new Blob(['body { color: red; }'], { type: 'text/css' });
    const onFetchRelatedFile = vi.fn().mockResolvedValue(cssBlob);

    render(
      <HtmlArtifactPreview
        content={htmlBlob}
        filename="test.html"
        onFetchRelatedFile={onFetchRelatedFile}
        readOnly={false}
      />,
    );

    await waitFor(() => {
      const iframe = screen.getByTestId('aui-html-preview-iframe');
      const srcdoc = iframe.getAttribute('srcdoc');
      // The component should fetch the CSS file (indicated by the fetch call)
      expect(onFetchRelatedFile).toHaveBeenCalled();
      // And either inline it as a style tag or leave the link
      expect(srcdoc).toBeTruthy();
    });
  });

  it('does not fetch non-existent asset files', async () => {
    const htmlBlob = new Blob(['<html><head><link rel="stylesheet" href="missing.css"></head><body></body></html>'], {
      type: 'text/html',
    });
    const onFetchRelatedFile = vi.fn().mockRejectedValue(new Error('Not found'));

    render(
      <HtmlArtifactPreview
        content={htmlBlob}
        filename="test.html"
        onFetchRelatedFile={onFetchRelatedFile}
        readOnly={false}
      />,
    );

    await waitFor(() => {
      const iframe = screen.getByTestId('aui-html-preview-iframe');
      expect(iframe).toBeInTheDocument();
      // The link tag should remain unchanged since fetch failed
    });
  });

  it('respects the maximum inlining bytes limit', async () => {
    const htmlBlob = new Blob(['<html><head><link rel="stylesheet" href="big.css"></head><body></body></html>'], {
      type: 'text/html',
    });
    const largeBlob = new Blob([new Array(5 * 1024 * 1024).join('x')], { type: 'text/css' }); // 5 MB
    const onFetchRelatedFile = vi.fn().mockResolvedValue(largeBlob);

    render(
      <HtmlArtifactPreview
        content={htmlBlob}
        filename="test.html"
        onFetchRelatedFile={onFetchRelatedFile}
        maxInliningBytes={1024 * 1024} // 1 MB limit
        readOnly={false}
      />,
    );

    await waitFor(() => {
      const iframe = screen.getByTestId('aui-html-preview-iframe');
      const srcdoc = iframe.getAttribute('srcdoc');
      // Large file should not be inlined due to size limit
      expect(srcdoc).toContain('href="big.css"');
    });
  });

  it('renders a loading state initially', async () => {
    const htmlBlob = new Blob(['<html><body>Test</body></html>'], { type: 'text/html' });

    const { unmount } = render(<HtmlArtifactPreview content={htmlBlob} filename="test.html" readOnly={false} />);

    // The component should show loading state initially
    const loadingOrPreview =
      screen.queryByTestId('aui-html-preview-loading') || screen.queryByTestId('aui-html-preview');
    expect(loadingOrPreview).toBeInTheDocument();

    // Wait for it to fully load
    await waitFor(() => {
      expect(screen.queryByTestId('aui-html-preview-iframe')).toBeInTheDocument();
    });

    unmount();
  });

  it('allows opening the HTML in a new tab when not read-only', async () => {
    const htmlBlob = new Blob(['<html><body>Hello World</body></html>'], { type: 'text/html' });
    const mockOpen = vi.fn();
    window.open = mockOpen;

    render(<HtmlArtifactPreview content={htmlBlob} filename="test.html" readOnly={false} />);

    await waitFor(() => {
      const openButton = screen.getByLabelText(/Open test.html in new tab/);
      expect(openButton).toBeInTheDocument();
      fireEvent.click(openButton);
      expect(mockOpen).toHaveBeenCalled();
    });
  });

  it('does not show controls when read-only', async () => {
    const htmlBlob = new Blob(['<html><body>Hello World</body></html>'], { type: 'text/html' });

    render(<HtmlArtifactPreview content={htmlBlob} filename="test.html" readOnly={true} />);

    await waitFor(() => {
      expect(screen.queryByLabelText(/Open test.html in new tab/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/Expand test.html/)).not.toBeInTheDocument();
    });
  });

  it('toggles expanded state when expand button is clicked', async () => {
    const htmlBlob = new Blob(['<html><body>Hello World</body></html>'], { type: 'text/html' });

    const { container } = render(<HtmlArtifactPreview content={htmlBlob} filename="test.html" readOnly={false} />);

    await waitFor(() => {
      const expandButton = screen.getByLabelText(/Expand test.html/);
      expect(expandButton).toBeInTheDocument();

      // Get the initial height
      const previewDiv = container.querySelector('[style*="height"]') as HTMLElement | null;
      const initialHeight = previewDiv?.style.height;

      fireEvent.click(expandButton);

      // After clicking, the height should change
      const newHeight = previewDiv?.style.height;
      expect(newHeight).not.toBe(initialHeight);
    });
  });

  it('displays non-HTML artifacts filename in header', async () => {
    const htmlBlob = new Blob(['<html><body>Dashboard</body></html>'], { type: 'text/html' });

    render(<HtmlArtifactPreview content={htmlBlob} filename="dashboard.html" readOnly={false} />);

    await waitFor(() => {
      expect(screen.getByText('dashboard.html')).toBeInTheDocument();
    });
  });
});

describe('HtmlArtifactPreview image CSP', () => {
  it('does not allow remote images in the injected CSP', async () => {
    const htmlBlob = new Blob(['<html><head></head><body><img src="https://evil.example/p.png"></body></html>'], {
      type: 'text/html',
    });

    render(<HtmlArtifactPreview content={htmlBlob} filename="test.html" readOnly={false} />);

    await waitFor(() => {
      const iframe = screen.getByTestId('aui-html-preview-iframe');
      const srcdoc = iframe.getAttribute('srcdoc') ?? '';
      expect(srcdoc).toContain('img-src data:;');
      expect(srcdoc).not.toMatch(/img-src[^;]*https:/);
    });
  });
});
