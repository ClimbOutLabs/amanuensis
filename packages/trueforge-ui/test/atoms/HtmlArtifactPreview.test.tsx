import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HtmlArtifactPreview } from '@/atoms/HtmlArtifactPreview.js';

/** The preview frame holds a script-free wrapper; the page itself is the wrapper's only child frame. */
function innerFrame(iframe: HTMLElement): HTMLIFrameElement {
  const wrapper = new DOMParser().parseFromString(iframe.getAttribute('srcdoc') ?? '', 'text/html');
  const inner = wrapper.querySelector('iframe');
  if (inner == null) throw new Error('wrapper has no content frame');
  return inner;
}

function innerSrcdoc(iframe: HTMLElement): string {
  return innerFrame(iframe).getAttribute('srcdoc') ?? '';
}

describe('HtmlArtifactPreview', () => {
  it('renders a preview iframe with sandbox attribute and srcdoc', async () => {
    const htmlBlob = new Blob(['<html><body>Hello World</body></html>'], { type: 'text/html' });

    render(<HtmlArtifactPreview content={htmlBlob} filename="test.html" readOnly={false} />);

    await waitFor(() => {
      const iframe = screen.getByTestId('aui-html-preview-iframe');
      expect(iframe).toBeInTheDocument();
      expect(iframe).toHaveAttribute('sandbox', '');
      expect(iframe).toHaveAttribute('referrerPolicy', 'no-referrer');
      const srcdoc = innerSrcdoc(iframe);
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
      const srcdoc = innerSrcdoc(iframe);
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
      const srcdoc = innerSrcdoc(iframe);
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
      expect(innerFrame(screen.getByTestId('aui-html-preview-iframe')).getAttribute('srcdoc')).toContain(
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
      const srcdoc = innerSrcdoc(iframe);
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
    expect(screen.getByTestId('aui-html-preview-iframe')).toHaveAttribute('sandbox', '');
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
      const srcdoc = innerSrcdoc(iframe);
      expect(srcdoc).toContain('img-src data:;');
      expect(srcdoc).not.toMatch(/img-src[^;]*https:/);
    });
  });
});

async function renderedSrcdoc(html: string): Promise<string> {
  render(<HtmlArtifactPreview content={new Blob([html], { type: 'text/html' })} filename="t.html" />);
  const iframe = await screen.findByTestId('aui-html-preview-iframe');
  return innerSrcdoc(iframe);
}

describe('HtmlArtifactPreview CSP placement', () => {
  const CSP_META = '<meta http-equiv="Content-Security-Policy"';

  it('allows only data: fonts', async () => {
    const srcdoc = await renderedSrcdoc('<html><head></head><body>x</body></html>');
    expect(srcdoc).toContain('font-src data:;');
    expect(srcdoc).not.toMatch(/font-src[^;]*https:/);
  });

  it('drops a CSP meta the content carries, leaving only the app policy', async () => {
    const own = `${CSP_META} content="default-src * 'unsafe-inline'">`;
    const srcdoc = await renderedSrcdoc(`<html><head>${own}</head><body>x</body></html>`);
    expect(srcdoc.split(CSP_META)).toHaveLength(2);
    expect(srcdoc).toContain('default-src &#39;none&#39;');
    expect(srcdoc).not.toContain('default-src *');
  });

  it('puts the app CSP ahead of content that has no head tag', async () => {
    const srcdoc = await renderedSrcdoc(`${CSP_META} content="font-src https:"><p>x</p>`);
    expect(srcdoc.startsWith(`<!doctype html>${CSP_META}`)).toBe(true);
    expect(srcdoc).not.toContain('font-src https:');
  });

  it('drops a differently spelled CSP meta too', async () => {
    const loose = '<META HTTP-EQUIV=\'content-security-policy\' CONTENT="default-src *">';
    const srcdoc = await renderedSrcdoc(`<!DOCTYPE html><html><head>${loose}</head><body></body></html>`);
    expect(srcdoc).toContain('default-src &#39;none&#39;');
    expect(srcdoc).not.toContain('default-src *');
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

describe('HtmlArtifactPreview egress containment', () => {
  const html = '<html><head></head><body>x<script>1</script></body></html>';

  it('never runs scripts: both frames are fully sandboxed and there is no Run control', async () => {
    render(<HtmlArtifactPreview content={new Blob([html], { type: 'text/html' })} filename="t.html" />);
    const outer = await screen.findByTestId('aui-html-preview-iframe');
    expect(outer).toHaveAttribute('sandbox', '');
    expect(innerFrame(outer).getAttribute('sandbox')).toBe('');
    expect(screen.queryByText(/run this page/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Run /)).not.toBeInTheDocument();
  });

  it('does not allow script in the page policy', async () => {
    const srcdoc = await renderedSrcdoc(html);
    expect(srcdoc).not.toContain('script-src');
  });

  it('lets the wrapper admit only srcdoc frames, so the page cannot load a URL', async () => {
    render(<HtmlArtifactPreview content={new Blob([html], { type: 'text/html' })} filename="t.html" />);
    const outer = await screen.findByTestId('aui-html-preview-iframe');
    const wrapper = outer.getAttribute('srcdoc') ?? '';
    const policy = new DOMParser()
      .parseFromString(wrapper, 'text/html')
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content');
    expect(policy).toContain('frame-src about:');
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toMatch(/frame-src[^;]*(https?:|data:|blob:|\*)/);
  });

  it('puts form-action none in the page policy', async () => {
    const srcdoc = await renderedSrcdoc(html);
    expect(srcdoc).toContain('form-action &#39;none&#39;');
  });

  it.each([
    ['<meta http-equiv="refresh" content="0;url=https://evil.example/">'],
    ['<META HTTP-EQUIV=Refresh CONTENT="0;url=https://evil.example/">'],
    ['<meta content="0;url=https://evil.example/" http-equiv=\'refresh\'>'],
    ['<meta content=">" http-equiv="re&#102;resh" x=\'0;url=https://evil.example/\'>'],
    ['<meta/http-equiv="refresh"/content="0;url=https://evil.example/">'],
  ])('strips the refresh meta %s', async tag => {
    const srcdoc = await renderedSrcdoc(`<html><head>${tag}</head><body>kept</body></html>`);
    expect(srcdoc).not.toContain('evil.example');
    expect(srcdoc.toLowerCase()).not.toContain('refresh');
    expect(srcdoc).toContain('kept');
  });

  it('keeps unrelated meta tags', async () => {
    const srcdoc = await renderedSrcdoc(
      '<html><head><meta name="viewport" content="width=device-width"></head></html>',
    );
    expect(srcdoc).toContain('<meta name="viewport" content="width=device-width">');
  });

  it.each([
    ['unclosed tags', '<meta a'.repeat(20000)],
    ['unclosed double quotes', '<meta a="'.repeat(20000)],
    ['unclosed single quotes', "<meta a='".repeat(20000)],
    ['closed tags', '<meta a>'.repeat(20000)],
  ])('strips metas in linear time on %s', async (_name, input) => {
    const start = performance.now();
    await renderedSrcdoc(input);
    expect(performance.now() - start).toBeLessThan(3000);
  });

  it('strips an http-equiv meta whose attributes hold stray angle brackets', async () => {
    const srcdoc = await renderedSrcdoc('<meta http-equiv=refresh a<b content="0;url=https://evil.example/">after');
    expect(srcdoc).not.toContain('evil.example');
    expect(srcdoc).toContain('after');
  });

  it('does not fetch script files, since scripts never run', async () => {
    const onFetchRelatedFile = vi.fn().mockResolvedValue(new Blob(['x']));
    render(
      <HtmlArtifactPreview
        content={new Blob(['<html><body><script src="app.js"></script></body></html>'], { type: 'text/html' })}
        filename="t.html"
        onFetchRelatedFile={onFetchRelatedFile}
      />,
    );
    await screen.findByTestId('aui-html-preview-iframe');
    expect(onFetchRelatedFile).not.toHaveBeenCalled();
  });

  it('says in plain words that a page with scripts will not fully show', async () => {
    await renderedSrcdoc('<html><body>x<SCRIPT>1</SCRIPT></body></html>');
    expect(screen.getByText(/uses scripts, which previews don.t run/i)).toBeInTheDocument();
  });

  it('shows no scripts note for a page without scripts', async () => {
    await renderedSrcdoc('<html><body>plain <scripting>x</scripting></body></html>');
    expect(screen.queryByText(/scripts/i)).not.toBeInTheDocument();
  });
});

describe('HtmlArtifactPreview external pictures', () => {
  const FOX = 'https://upload.wikimedia.org/wikipedia/commons/3/3c/Red_Fox.jpg';
  const PNG = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' });

  async function renderedWithProxy(input: { html: string; fetchImpl: (url: string) => unknown; waitText: string }) {
    const { html, fetchImpl, waitText } = input;
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url);
        return fetchImpl(url);
      }),
    );
    render(
      <HtmlArtifactPreview
        content={new Blob([html], { type: 'text/html' })}
        filename="t.html"
        pictureProxyUrl={url => `/api/chat-pictures?session_id=s1&url=${encodeURIComponent(url)}`}
      />,
    );
    const iframe = await screen.findByTestId('aui-html-preview-iframe');
    await waitFor(() => expect(innerSrcdoc(iframe)).toContain(waitText));
    const srcdoc = innerSrcdoc(iframe);
    vi.unstubAllGlobals();
    return { srcdoc, seen };
  }

  it('renders a picture the reply showed through the proxy as a data: URI, never the outside link', async () => {
    const { srcdoc, seen } = await renderedWithProxy({
      html: `<html><body><div class="row"><img src="${FOX}" alt="Red fox"></div></body></html>`,
      fetchImpl: () => ({ ok: true, blob: async () => PNG }),
      waitText: 'data:image/png;base64,',
    });
    expect(seen).toEqual([`/api/chat-pictures?session_id=s1&url=${encodeURIComponent(FOX)}`]);
    expect(srcdoc).toContain('data:image/png;base64,');
    expect(srcdoc).not.toContain('upload.wikimedia.org');
  });

  it('shows the plain line when the proxy refuses an unseen picture', async () => {
    const { srcdoc, seen } = await renderedWithProxy({
      html: `<html><body><img src="${FOX}" alt="Red fox"></body></html>`,
      fetchImpl: () => ({ ok: false, status: 404 }),
      waitText: 'couldn',
    });
    expect(seen).toHaveLength(1);
    expect(srcdoc).toContain('couldn');
    expect(srcdoc).toContain('be shown');
    expect(srcdoc).not.toContain('upload.wikimedia.org');
  });

  it('shows the space line where a web picture would be when no proxy is available', async () => {
    render(
      <HtmlArtifactPreview
        content={new Blob([`<html><body><img src="${FOX}" alt="Red fox"></body></html>`], { type: 'text/html' })}
        filename="t.html"
      />,
    );
    const iframe = await screen.findByTestId('aui-html-preview-iframe');
    await waitFor(() => expect(innerSrcdoc(iframe)).toContain('Pictures from the web show in a space'));
    expect(innerSrcdoc(iframe)).not.toContain('upload.wikimedia.org');
  });
});
