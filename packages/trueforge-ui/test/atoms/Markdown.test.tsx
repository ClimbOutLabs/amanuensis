// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExternalUrlConfirmProvider, MarkdownExternalLink } from '@/atoms/externalUrlConfirm.js';
import { EXTERNAL_URL_TRUST_STORAGE_KEY } from '@/atoms/externalUrlTrust.js';
import { LARGE_STREAMING_FENCE_CHARS, Markdown, getActiveStreamingFenceCode } from '@/atoms/Markdown.js';
import type { SyntaxHighlighterProps } from '@/atoms/SyntaxHighlighter.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';

// Real KaTeX only throws for genuinely unrecoverable input, which is hard to construct on
// purpose; this sentinel forces `rehype-katex`'s error-span fallback for one test while every
// other math test still renders through the real renderer.
const FORCE_KATEX_ERROR_SENTINEL = '__FORCE_KATEX_ERROR__';

vi.mock('katex', async importOriginal => {
  const actual = await importOriginal<typeof import('katex')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      renderToString(input: string, options?: Parameters<typeof actual.default.renderToString>[1]) {
        if (input === FORCE_KATEX_ERROR_SENTINEL) {
          throw new Error('forced KaTeX error for test');
        }
        return actual.default.renderToString(input, options);
      },
    },
  };
});

// @openuidev mocks are in testSetup.ts; they make OpenUiFenceBlock render
// a simple div with data-testid="aui-openui-renderer" synchronously.
// The <dialog> showModal/close mocks the external URL confirm dialog needs
// are also in testSetup.ts.

afterEach(() => {
  window.localStorage.removeItem(EXTERNAL_URL_TRUST_STORAGE_KEY);
  vi.restoreAllMocks();
});

describe('getActiveStreamingFenceCode', () => {
  it('returns null when every fence is closed', () => {
    expect(getActiveStreamingFenceCode('```js\nconst x = 1;\n```\n\ndone')).toBeNull();
  });

  it('returns the body of the final unmatched fence', () => {
    const body = 'x'.repeat(100);
    expect(getActiveStreamingFenceCode(`intro\n\n\`\`\`json\n${body}`)).toBe(body);
  });
});

describe('Markdown', () => {
  it('renders basic markdown formatting', () => {
    render(<Markdown content="**bold** text" />);
    const strong = screen.getByText('bold');
    expect(strong.tagName).toBe('STRONG');
    expect(strong.closest('.markdown-body')).toBeTruthy();
  });

  it('marks external links for a new tab and confirms before opening', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<Markdown content="See [docs](https://example.com/docs) for details." />);
    const link = screen.getByRole('link', { name: 'docs' });
    // Unapproved external destinations stay off href so middle-click / context-menu cannot bypass.
    expect(link).toHaveAttribute('href', '#');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).not.toHaveAttribute('node');

    fireEvent.click(link);
    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Open external link' })).toBeInTheDocument();
    expect(screen.getByTestId('aui-external-url-confirm-url')).toHaveTextContent('https://example.com/docs');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Open external link' })).not.toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();

    fireEvent.click(link);
    fireEvent.click(screen.getByRole('button', { name: 'Open link' }));
    expect(openSpy).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
  });

  it('confirms protocol-relative external links and blocks middle-click bypass', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<Markdown content="See [cdn](//cdn.example.com/a) for details." />);
    const link = screen.getByRole('link', { name: 'cdn' });
    expect(link).toHaveAttribute('href', '#');

    fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Open external link' })).toBeInTheDocument();
    expect(screen.getByTestId('aui-external-url-confirm-url')).toHaveTextContent('//cdn.example.com/a');

    fireEvent.click(screen.getByRole('button', { name: 'Open link' }));
    const expected = new URL('//cdn.example.com/a', window.location.href).href;
    expect(openSpy).toHaveBeenCalledWith(expected, '_blank', 'noopener,noreferrer');
  });

  it('blocks javascript, data, and vbscript href activation', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    render(
      <ExternalUrlConfirmProvider>
        <MarkdownExternalLink href="javascript:alert(1)">js</MarkdownExternalLink>
        <MarkdownExternalLink href="data:text/html,hi">data</MarkdownExternalLink>
        <MarkdownExternalLink href="vbscript:msgbox(1)">vb</MarkdownExternalLink>
      </ExternalUrlConfirmProvider>,
    );

    for (const name of ['js', 'data', 'vb'] as const) {
      const el = screen.getByText(name);
      expect(el).not.toHaveAttribute('href');
      fireEvent.click(el);
      fireEvent(el, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    }

    expect(screen.queryByRole('dialog', { name: 'Open external link' })).not.toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('skips the link dialog after trusting a host', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<Markdown content="See [docs](https://example.com/docs) for details." />);
    const link = screen.getByRole('link', { name: 'docs' });

    fireEvent.click(link);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Open link' }));
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(link).toHaveAttribute('href', '#');

    fireEvent.click(link);
    expect(screen.queryByRole('dialog', { name: 'Open external link' })).not.toBeInTheDocument();
    expect(openSpy).toHaveBeenCalledTimes(2);
  });

  it('does not confirm same-origin links', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const href = `${window.location.origin}/local-docs`;
    render(<Markdown content={`See [local](${href}) for details.`} />);
    fireEvent.click(screen.getByRole('link', { name: 'local' }));
    expect(screen.queryByRole('dialog', { name: 'Open external link' })).not.toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('renders openui fenced blocks via OpenUiFenceBlock', async () => {
    render(<Markdown content={'```openui\nCard() { title: "Sales" }\n```'} />);
    await waitFor(() => {
      expect(screen.getByTestId('aui-openui-renderer')).toBeInTheDocument();
    });
    expect(screen.getByTestId('aui-openui-renderer')).toHaveTextContent('Card() { title: "Sales" }');
    expect(document.querySelector('.code-block-header')).not.toBeInTheDocument();
  });

  it('renders a code fence with syntax highlighting for non-openui languages', () => {
    render(<Markdown content={'```js\nconst x = 1;\n```'} />);
    // react-syntax-highlighter renders the code as text nodes inside the fence block.
    expect(screen.getByText(/const x = 1/)).toBeInTheDocument();
  });

  it('keeps Prism for small streaming fences', () => {
    render(<Markdown content={'```json\n{"a":1}\n```'} isStreaming />);
    expect(screen.queryByTestId('aui-plain-streaming-fence')).not.toBeInTheDocument();
    expect(screen.getByTestId('aui-syntax-highlighter')).toBeInTheDocument();
  });

  it('keeps Prism for large closed fences while the message is still streaming', () => {
    const huge = 'x'.repeat(LARGE_STREAMING_FENCE_CHARS + 1);
    render(<Markdown content={`\`\`\`json\n${huge}\n\`\`\`\n\nmore text`} isStreaming />);
    expect(screen.queryByTestId('aui-plain-streaming-fence')).not.toBeInTheDocument();
    expect(screen.getByTestId('aui-syntax-highlighter')).toBeInTheDocument();
  });

  it('falls back to a plain pre only for the active unmatched oversized fence', () => {
    const closed = 'c'.repeat(LARGE_STREAMING_FENCE_CHARS + 1);
    const open = 'o'.repeat(LARGE_STREAMING_FENCE_CHARS + 1);
    render(<Markdown content={`\`\`\`json\n${closed}\n\`\`\`\n\n\`\`\`json\n${open}`} isStreaming />);
    expect(screen.getByTestId('aui-plain-streaming-fence')).toBeInTheDocument();
    expect(screen.getByTestId('aui-syntax-highlighter')).toBeInTheDocument();
    expect(screen.getByTestId('aui-plain-streaming-fence')).toHaveTextContent(open.slice(0, 32));
  });

  it('highlights large fences once streaming finishes', () => {
    const huge = 'x'.repeat(LARGE_STREAMING_FENCE_CHARS + 1);
    render(<Markdown content={`\`\`\`json\n${huge}\n\`\`\``} isStreaming={false} />);
    expect(screen.queryByTestId('aui-plain-streaming-fence')).not.toBeInTheDocument();
    expect(screen.getByTestId('aui-syntax-highlighter')).toBeInTheDocument();
  });

  it('normalizes a non-breaking hyphen to ASCII in prose', () => {
    render(<Markdown content="large‑scale rollout" />);
    expect(screen.getByText('large-scale rollout')).toBeInTheDocument();
  });

  it('leaves a non-breaking hyphen unchanged inside a fenced code block', () => {
    render(<Markdown content={'```\nlarge‑scale\n```'} />);
    expect(screen.getByText('large‑scale')).toBeInTheDocument();
  });

  it('leaves a non-breaking hyphen unchanged inside inline code', () => {
    render(<Markdown content="see `large‑scale` here" />);
    expect(screen.getByText('large‑scale')).toBeInTheDocument();
  });

  it('renders a literal <br> as a line break, and a following unicode-hyphen bullet as a separate list', () => {
    const { container } = render(<Markdown content={'(especially if you’re sleep‑deprived) <br>‑ Unusual fatigue'} />);

    const paragraph = container.querySelector('p');
    expect(paragraph).not.toBeNull();
    expect(paragraph!.querySelector('br')).toBeInTheDocument();
    expect(container.textContent).not.toContain('<br>');
    expect(container.textContent).not.toContain('‑');

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Unusual fatigue');
  });

  it('renders <br/> and <br /> the same way as <br>, case-insensitively', () => {
    const { container } = render(<Markdown content="a<BR/>b<br />c" />);
    expect(container.querySelectorAll('br')).toHaveLength(2);
    expect(container.textContent?.replace(/\n/g, '')).toBe('abc');
  });

  it('renders a <br> with no attributes even if the source tag carried one', () => {
    const { container } = render(<Markdown content='a<br id="x" class="y">b' />);
    const br = container.querySelector('br');
    expect(br).not.toBeNull();
    expect(br!.attributes.length).toBe(0);
  });

  it('leaves a literal <br> tag inside a fenced code block untouched', () => {
    render(<Markdown content={'```\nfoo<br>bar\n```'} />);
    expect(screen.getByText(/foo<br>bar/)).toBeInTheDocument();
  });

  it('leaves a literal <br> tag inside inline code untouched', () => {
    render(<Markdown content="see `a<br>b` here" />);
    expect(screen.getByText('a<br>b')).toBeInTheDocument();
  });

  it('leaves a unicode-hyphen bullet inside a fenced code block untouched', () => {
    const { container } = render(<Markdown content={'```\n‑ item\n```'} />);
    expect(container.querySelector('ul')).toBeNull();
    expect(screen.getByText(/‑ item/)).toBeInTheDocument();
  });

  it('leaves a literal <br> tag inside a tilde-fenced code block untouched', () => {
    render(<Markdown content={'~~~\nfoo<br>bar\n~~~'} />);
    expect(screen.getByText(/foo<br>bar/)).toBeInTheDocument();
  });

  it('leaves a literal <br> tag inside a fenced block nested in a blockquote untouched', () => {
    const { container } = render(<Markdown content={'> ```\n> foo<br>bar\n> ```'} />);
    expect(container.querySelector('blockquote')).toBeInTheDocument();
    expect(screen.getByText(/foo<br>bar/)).toBeInTheDocument();
  });

  it('does not split a paragraph in two when <br> is already followed by a newline', () => {
    const { container } = render(<Markdown content={'first line<br>\nsecond line'} />);
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.querySelector('br')).toBeInTheDocument();
    expect(paragraphs[0]!.textContent?.replace(/\s+/g, ' ').trim()).toBe('first line second line');
  });

  it('handles CRLF input around a <br> and a following bullet', () => {
    const { container } = render(<Markdown content={'intro\r\n<br>‑ item one\r\n‑ item two'} />);
    expect(container.querySelector('br')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items.map(item => item.textContent)).toEqual(['item one', 'item two']);
  });

  it('neutralises a raw <div> tag: no div element is rendered, and its content stays safe text', () => {
    const { container } = render(<Markdown content="<div>hello</div>" />);
    expect(container.querySelector('div.markdown-body div')).toBeNull();
    expect(container.textContent).toContain('hello');
  });

  it('neutralises a raw <script> tag: no script element, and its body is not present as text', () => {
    const { container } = render(<Markdown content="before <script>window.__pwned = true;</script> after" />);
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    expect(container.textContent).not.toContain('__pwned');
    expect(container.textContent).toContain('before');
    expect(container.textContent).toContain('after');
  });

  it('neutralises a raw <img> event handler: the element carries no onerror attribute', () => {
    const { container } = render(<Markdown content='<img src="x" onerror="window.__pwned = true">' />);
    const img = container.querySelector('img');
    if (img) {
      expect(img.getAttribute('onerror')).toBeNull();
    }
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('neutralises an unknown raw tag: no element is rendered, and its content stays safe text', () => {
    const { container } = render(<Markdown content="<weirdtag>content</weirdtag>" />);
    expect(container.querySelector('weirdtag')).toBeNull();
    expect(container.textContent).toContain('content');
  });

  it('renders markdown images unchanged', () => {
    render(<Markdown content="![alt text](data:image/png;base64,AAAA)" />);
    const img = screen.getByRole('img', { name: 'alt text' });
    expect(img).toHaveAttribute('src', 'data:image/png;base64,AAAA');
  });

  it('wraps a table on a read-only space page in its own scroll frame', () => {
    const { container } = render(<Markdown content={'| A | B |\n| - | - |\n| 1 | 2 |'} readOnly />);
    const frame = container.querySelector('.space-table-frame');
    expect(frame?.querySelector('.space-table-scroll table')).not.toBeNull();
  });

  it('leaves a table in chat as a plain table', () => {
    const { container } = render(<Markdown content={'| A | B |\n| - | - |\n| 1 | 2 |'} />);
    expect(container.querySelector('.space-table-frame')).toBeNull();
    expect(container.querySelector('table')).not.toBeNull();
  });

  it('renders a placeholder instead of a live img for remote markdown images', () => {
    render(<Markdown content="![alt text](https://example.com/pic.png)" />);
    expect(screen.getByTestId('aui-remote-image-placeholder')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders reference-style links and images unchanged', () => {
    render(
      <Markdown
        content={
          '[link][ref]\n\n![alt][imgref]\n\n[ref]: https://example.com/page "a title"\n[imgref]: data:image/png;base64,AAAA'
        }
      />,
    );
    const link = screen.getByRole('link', { name: 'link' });
    // External destinations stay off href until the person confirms (see the link tests above).
    expect(link).toHaveAttribute('href', '#');
    expect(link).toHaveAttribute('title', 'a title');
    const img = screen.getByRole('img', { name: 'alt' });
    expect(img).toHaveAttribute('src', 'data:image/png;base64,AAAA');
  });

  it('renders \\[ \\] display math as KaTeX', () => {
    const { container } = render(<Markdown content={'\\[ \\text{Volume}=\\pi r^2 h \\]'} />);
    expect(container.querySelector('.katex')).toBeInTheDocument();
    expect(container.textContent).not.toContain('\\[');
    expect(container.textContent).not.toContain('\\]');
  });

  it('renders \\( \\) inline math as KaTeX', () => {
    const { container } = render(<Markdown content={'The area is \\( \\pi r^2 \\) exactly.'} />);
    expect(container.querySelector('.katex')).toBeInTheDocument();
    expect(container.textContent).not.toContain('\\(');
    expect(container.textContent).not.toContain('\\)');
  });

  it('does not turn prose dollar amounts into math', () => {
    const { container } = render(<Markdown content="$5 and $10" />);
    expect(container.querySelector('.katex')).not.toBeInTheDocument();
    expect(container.textContent).toContain('$5 and $10');
  });

  it('leaves \\[ \\] untouched inside a fenced code block', () => {
    const { container } = render(<Markdown content={'```\n\\[ x \\]\n```'} />);
    expect(container.querySelector('.katex')).not.toBeInTheDocument();
    expect(screen.getByText(/\\\[ x \\\]/)).toBeInTheDocument();
  });

  it('strips a raw <span style> while still rendering display and inline KaTeX output', () => {
    const content = '<span style="position:fixed;inset:0">x</span>\n\n$$ y^2 $$\n\nand $$z$$ inline.';
    const { container } = render(<Markdown content={content} />);
    // The `span` tag itself is not in the sanitize allowlist, so a raw one is unwrapped to its
    // text content rather than rendered as a live element at all.
    expect(screen.getByText('x').tagName).not.toBe('SPAN');
    expect(container.innerHTML).not.toContain('position:fixed');
    const katexNodes = container.querySelectorAll('.katex');
    expect(katexNodes.length).toBeGreaterThanOrEqual(2);
  });

  it('still renders a KaTeX error span (with its title) for invalid math', () => {
    const { container } = render(<Markdown content={`$$${FORCE_KATEX_ERROR_SENTINEL}$$`} />);
    const errorSpan = container.querySelector('.katex-error');
    expect(errorSpan).toBeInTheDocument();
    expect(errorSpan).toHaveAttribute('title');
  });

  it('does not remount a completed code block when later markdown is appended', () => {
    let mountCount = 0;
    function TrackingHighlighter({ code, language }: SyntaxHighlighterProps) {
      useEffect(() => {
        mountCount += 1;
      }, []);
      return (
        <pre data-testid="aui-syntax-highlighter" data-language={language}>
          {code}
        </pre>
      );
    }

    const closedBody = 'const completed = true;';
    const prefix = `\`\`\`js\n${closedBody}\n\`\`\`\n\n`;

    const { rerender } = render(
      <SlotsProvider overrides={{ SyntaxHighlighter: TrackingHighlighter }}>
        <Markdown content={`${prefix}growing`} isStreaming />
      </SlotsProvider>,
    );

    expect(screen.getByTestId('aui-syntax-highlighter')).toHaveTextContent(closedBody);
    expect(mountCount).toBe(1);

    rerender(
      <SlotsProvider overrides={{ SyntaxHighlighter: TrackingHighlighter }}>
        <Markdown content={`${prefix}growing more text after the fence`} isStreaming />
      </SlotsProvider>,
    );

    expect(screen.getByTestId('aui-syntax-highlighter')).toHaveTextContent(closedBody);
    expect(mountCount).toBe(1);
  });

  it('transforms citation markers into links when sources are available', () => {
    const sources = [{ id: 1, title: 'My Source', url: 'https://example.com/source' }];
    const { container } = render(<Markdown content="Citation【1†excerpt】here." citationSources={sources} />);
    const markdown = container.querySelector('.aui-markdown');
    // Check that the link was created with the correct URL
    expect(markdown?.innerHTML).toContain('https://example.com/source');
  });

  it('removes unresolved citation markers when sources are not available', () => {
    const { container } = render(<Markdown content="Text【14†excerpt】end." citationSources={null} />);
    const markdown = container.querySelector('.aui-markdown');
    // The marker【14†excerpt】 should be removed entirely
    expect(markdown?.textContent).not.toContain('【14');
    expect(markdown?.textContent).toContain('Text');
    expect(markdown?.textContent).toContain('end');
  });

  it('removes citation markers when no matching source is found', () => {
    const sources = [{ id: 1, title: 'Wrong Source', url: 'https://example.com/1' }];
    const { container } = render(<Markdown content="Start【14†excerpt】finish." citationSources={sources} />);
    const markdown = container.querySelector('.aui-markdown');
    // The unresolved marker【14†excerpt】 should be removed
    expect(markdown?.textContent).not.toContain('【14');
    expect(markdown?.textContent).toContain('Start');
    expect(markdown?.textContent).toContain('finish');
  });

  it('preserves citation markers inside code blocks untouched', () => {
    render(<Markdown content={'Code example: `【14†inline】` in code block.'} citationSources={null} />);
    // The marker inside inline code should be preserved
    expect(screen.getByText('【14†inline】')).toBeInTheDocument();
  });

  it('preserves citation markers inside fenced code blocks untouched', () => {
    const content = 'Text【1†prose】\n```\nCode【14†ignored】\n```';
    const sources = [{ id: 1, title: 'Source 1', url: 'https://example.com/1' }];
    render(<Markdown content={content} citationSources={sources} />);
    // The marker in fenced code should be preserved unchanged
    expect(screen.getByText(/Code【14†ignored】/)).toBeInTheDocument();
  });
});

describe('Markdown remote images', () => {
  it('renders a placeholder instead of a live img for a markdown https image', () => {
    render(<Markdown content="![chart](https://evil.example/p.png?d=secret)" />);
    expect(screen.getByTestId('aui-remote-image-placeholder')).toBeInTheDocument();
    expect(document.querySelector('img')).not.toBeInTheDocument();
  });

  it('renders a placeholder for a raw <img> tag with a remote src', () => {
    render(<Markdown content={'<img src="https://evil.example/p.png" alt="pic" />'} />);
    expect(screen.getByTestId('aui-remote-image-placeholder')).toBeInTheDocument();
    expect(document.querySelector('img')).not.toBeInTheDocument();
  });

  it('renders a placeholder for an http:// image', () => {
    render(<Markdown content="![x](http://evil.example/p.png)" />);
    expect(screen.getByTestId('aui-remote-image-placeholder')).toBeInTheDocument();
    expect(document.querySelector('img')).not.toBeInTheDocument();
  });

  it('renders a placeholder for a protocol-relative image', () => {
    render(<Markdown content="![x](//evil.example/p.png)" />);
    expect(screen.getByTestId('aui-remote-image-placeholder')).toBeInTheDocument();
    expect(document.querySelector('img')).not.toBeInTheDocument();
  });

  it('shows the destination host and alt text on the placeholder', () => {
    render(<Markdown content="![sales chart](https://evil.example/p.png)" />);
    const placeholder = screen.getByTestId('aui-remote-image-placeholder');
    expect(placeholder).toHaveTextContent('evil.example');
    expect(placeholder).toHaveTextContent('sales chart');
  });

  it('offers an open-in-a-new-tab link on the thumbnail', () => {
    render(<Markdown content="![x](https://evil.example/p.png)" />);
    const link = within(screen.getByTestId('aui-remote-image-placeholder')).getByRole('link', { name: 'Open image' });
    expect(link).toHaveAttribute('href', 'https://evil.example/p.png');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('keeps the remote image off the page until the person confirms it', () => {
    render(<Markdown content="![sales chart](https://evil.example/p.png)" />);
    expect(document.querySelector('img[src="https://evil.example/p.png"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show image: sales chart' }));
    // The confirm dialog stands between the ask and any request to the host.
    expect(screen.getByRole('dialog', { name: 'Show external image' })).toBeInTheDocument();
    expect(screen.getByTestId('aui-external-url-confirm-url')).toHaveTextContent('https://evil.example/p.png');
    expect(document.querySelector('img[src="https://evil.example/p.png"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show image' }));
    const img = screen.getByRole('img', { name: 'sales chart' });
    expect(img).toHaveAttribute('src', 'https://evil.example/p.png');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('keeps the remote image off the page when the person cancels the confirm', () => {
    render(<Markdown content="![sales chart](https://evil.example/p.png)" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show image: sales chart' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Show external image' })).not.toBeInTheDocument();
    expect(document.querySelector('img[src="https://evil.example/p.png"]')).toBeNull();
    expect(screen.getByTestId('aui-remote-image-placeholder')).toBeInTheDocument();
  });

  it('loads a remote image without asking when its host is trusted on this device', () => {
    window.localStorage.setItem(
      EXTERNAL_URL_TRUST_STORAGE_KEY,
      JSON.stringify({ version: 1, links: [], images: ['evil.example'] }),
    );
    render(<Markdown content="![sales chart](https://evil.example/p.png)" />);
    expect(screen.queryByRole('button', { name: 'Show image: sales chart' })).toBeNull();
    const img = screen.getByRole('img', { name: 'sales chart' });
    expect(img).toHaveAttribute('src', 'https://evil.example/p.png');
  });

  it('shows the alt text, not an empty box, when a requested remote image fails', () => {
    render(<Markdown content="![sales chart](https://evil.example/p.png)" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show image: sales chart' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show image' }));
    fireEvent.error(screen.getByRole('img', { name: 'sales chart' }));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByTestId('aui-remote-image-placeholder')).toHaveTextContent('Image unavailable: sales chart');
  });

  it('still renders data: images inline', () => {
    render(<Markdown content="![x](data:image/png;base64,AAAA)" />);
    const img = document.querySelector('img');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'data:image/png;base64,AAAA');
    expect(screen.queryByTestId('aui-remote-image-placeholder')).not.toBeInTheDocument();
  });

  it('still renders same-origin images inline', () => {
    render(<Markdown content="![x](/assets/pic.png)" />);
    const img = document.querySelector('img');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', '/assets/pic.png');
    expect(screen.queryByTestId('aui-remote-image-placeholder')).not.toBeInTheDocument();
  });

  it('still renders blob: images inline', () => {
    render(<Markdown content="![x](blob:https://example.com/1234)" />);
    const img = document.querySelector('img');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'blob:https://example.com/1234');
    expect(screen.queryByTestId('aui-remote-image-placeholder')).not.toBeInTheDocument();
  });

  it('renders nothing for an image with an empty src', () => {
    const { container } = render(<Markdown content="![x]()" />);
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.queryByTestId('aui-remote-image-placeholder')).not.toBeInTheDocument();
  });
});

describe('Markdown space pictures', () => {
  const PICTURE = 'https://cdn.photos.test/chart.png';
  const ROUTE = `/api/space-pictures?url=${encodeURIComponent(PICTURE)}`;

  it('loads an https picture on its own through the owner’s picture route, with no referrer', () => {
    render(<Markdown content={`![sales chart](${PICTURE})`} spacePictures />);
    expect(screen.queryByRole('button', { name: 'Show image: sales chart' })).toBeNull();
    const img = screen.getByRole('img', { name: 'sales chart' });
    expect(img).toHaveAttribute('src', ROUTE);
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('shows the one plain line when the picture cannot be shown', () => {
    render(<Markdown content={`![sales chart](${PICTURE})`} spacePictures />);
    fireEvent.error(screen.getByRole('img', { name: 'sales chart' }));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByTestId('aui-space-picture-failed')).toHaveTextContent('This picture could not be shown.');
  });

  it('keeps a picture that is not https as a plain link, never an image', () => {
    const { container } = render(<Markdown content="![sales chart](http://cdn.photos.test/chart.png)" spacePictures />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'sales chart' })).toHaveAttribute(
      'href',
      'http://cdn.photos.test/chart.png',
    );
  });

  it('keeps a protocol-relative picture as a plain link', () => {
    const { container } = render(<Markdown content="![x](//cdn.photos.test/chart.png)" spacePictures />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'x' })).toBeInTheDocument();
  });

  it('keeps the click-to-load thumbnail on read-only pages that are not spaces', () => {
    render(<Markdown content={`![sales chart](${PICTURE})`} readOnly />);
    expect(screen.getByRole('button', { name: 'Show image: sales chart' })).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('markdownUrlTransform', () => {
  it('keeps data: and blob: URLs', async () => {
    const { markdownUrlTransform } = await import('@/atoms/Markdown.js');
    expect(markdownUrlTransform('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(markdownUrlTransform('blob:https://example.com/1234')).toBe('blob:https://example.com/1234');
  });

  it('keeps http, https and relative URLs', async () => {
    const { markdownUrlTransform } = await import('@/atoms/Markdown.js');
    expect(markdownUrlTransform('https://example.com/p.png')).toBe('https://example.com/p.png');
    expect(markdownUrlTransform('/assets/pic.png')).toBe('/assets/pic.png');
  });

  it('strips javascript: URLs', async () => {
    const { markdownUrlTransform } = await import('@/atoms/Markdown.js');
    expect(markdownUrlTransform('javascript:alert(1)')).toBe('');
  });
});
