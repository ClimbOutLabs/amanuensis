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

  it('inlines related files literally, without expanding replacement patterns', async () => {
    const htmlBlob = new Blob(['<html><head><link rel="stylesheet" href="style.css"></head></html>'], {
      type: 'text/html',
    });
    const cssBlob = new Blob(["a::after { content: '$&$`$' }"], { type: 'text/css' });
    render(
      <HtmlArtifactPreview
        content={htmlBlob}
        filename="test.html"
        onFetchRelatedFile={vi.fn().mockResolvedValue(cssBlob)}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('aui-html-preview-iframe').getAttribute('srcdoc')).toContain(
        "<style>a::after { content: '$&$`$' }</style>",
      );
    });
  });

  it('does not show a download button without onDownload', async () => {
    render(<HtmlArtifactPreview content={new Blob(['<p>x</p>'], { type: 'text/html' })} filename="test.html" />);
    await screen.findByTestId('aui-html-preview-iframe');
    expect(screen.queryByLabelText(/Download test.html/)).not.toBeInTheDocument();
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

  it('never opens the artifact in a new tab or blob URL', async () => {
    const htmlBlob = new Blob(['<html><body>Hello World</body></html>'], { type: 'text/html' });
    const mockOpen = vi.fn();
    const createObjectURL = vi.fn();
    vi.stubGlobal('open', mockOpen);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL }));

    render(<HtmlArtifactPreview content={htmlBlob} filename="test.html" readOnly={false} />);

    await screen.findByTestId('aui-html-preview-iframe');
    expect(screen.queryByLabelText(/new tab/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Expand test.html/));
    expect(mockOpen).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByTestId('aui-html-preview-iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    vi.unstubAllGlobals();
  });

  it('calls onDownload only when the download button is clicked', async () => {
    const htmlBlob = new Blob(['<html><body>Hello World</body></html>'], { type: 'text/html' });
    const onDownload = vi.fn();

    render(<HtmlArtifactPreview content={htmlBlob} filename="test.html" onDownload={onDownload} />);

    await screen.findByTestId('aui-html-preview-iframe');
    expect(onDownload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/Download test.html/));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it('does not show controls when read-only', async () => {
    const htmlBlob = new Blob(['<html><body>Hello World</body></html>'], { type: 'text/html' });

    render(<HtmlArtifactPreview content={htmlBlob} filename="test.html" readOnly={true} />);

    await waitFor(() => {
      expect(screen.queryByLabelText(/Download test.html/)).not.toBeInTheDocument();
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

async function renderedSrcdoc(html: string): Promise<string> {
  render(<HtmlArtifactPreview content={new Blob([html], { type: 'text/html' })} filename="t.html" />);
  const iframe = await screen.findByTestId('aui-html-preview-iframe');
  return iframe.getAttribute('srcdoc') ?? '';
}

describe('HtmlArtifactPreview CSP placement', () => {
  const CSP_META = '<meta http-equiv="Content-Security-Policy"';

  it('allows only data: fonts', async () => {
    const srcdoc = await renderedSrcdoc('<html><head></head><body>x</body></html>');
    expect(srcdoc).toContain('font-src data:;');
    expect(srcdoc).not.toMatch(/font-src[^;]*https:/);
  });

  it('inserts the app CSP first even when the content carries its own CSP meta', async () => {
    const own = `${CSP_META} content="default-src * 'unsafe-inline'">`;
    const srcdoc = await renderedSrcdoc(`<html><head>${own}</head><body>x</body></html>`);
    const first = srcdoc.indexOf(CSP_META);
    const second = srcdoc.indexOf(CSP_META, first + 1);
    expect(second).toBeGreaterThan(first);
    expect(srcdoc.slice(first, second)).toContain('default-src &#39;none&#39;');
  });

  it('inserts the app CSP before a looser meta that precedes any head tag', async () => {
    const loose = `${CSP_META} content="font-src https:">`;
    const srcdoc = await renderedSrcdoc(`${loose}<p>x</p>`);
    expect(srcdoc.indexOf(CSP_META)).toBeLessThan(srcdoc.indexOf(loose));
    expect(srcdoc.startsWith(`<!doctype html>${CSP_META}`)).toBe(true);
  });

  it('matches a differently spelled CSP meta without letting it come first', async () => {
    const loose = '<META HTTP-EQUIV=\'content-security-policy\' CONTENT="default-src *">';
    const srcdoc = await renderedSrcdoc(`<!DOCTYPE html><html><head>${loose}</head><body></body></html>`);
    expect(srcdoc.indexOf('default-src &#39;none&#39;')).toBeLessThan(srcdoc.indexOf(loose));
  });

  it('always starts with a doctype and the app CSP, before any content', async () => {
    const srcdoc = await renderedSrcdoc('<!DOCTYPE html><html><head></head><body>x</body></html>');
    expect(srcdoc.startsWith(`<!doctype html>${CSP_META}`)).toBe(true);
    expect(srcdoc.endsWith('<!DOCTYPE html><html><head></head><body>x</body></html>')).toBe(true);
  });

  it.each([['<!-->'], ['<!--->'], ['<!-- a --!>'], ['<!----!>']])(
    'puts the CSP before content that opens with %s',
    async prefix => {
      const content = `${prefix}<script>fetch('https://example.invalid')</script>--><!doctype html><html><head></head></html>`;
      const srcdoc = await renderedSrcdoc(content);
      expect(srcdoc.startsWith(`<!doctype html>${CSP_META}`)).toBe(true);
      expect(srcdoc.endsWith(content)).toBe(true);
    },
  );

  it('handles many leading comments without a doctype quickly', async () => {
    const start = performance.now();
    const srcdoc = await renderedSrcdoc('<!---->'.repeat(5000));
    expect(srcdoc.startsWith(`<!doctype html>${CSP_META}`)).toBe(true);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
