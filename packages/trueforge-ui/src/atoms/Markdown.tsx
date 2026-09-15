'use client';

import type { ComponentType, ReactNode } from 'react';
import { useMemo, useRef } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { PluggableList } from 'unified';

import { useSlot, useThemeMode } from '../theme/SlotsProvider.js';
import { useOptionalContentClassNames } from '../theme/ThemeProvider.js';
import { type CitationSource } from '../utils/citationMarkers.js';
import { remarkCitationMarkers } from '../utils/remarkCitationMarkers.js';
import { remarkNormalizeProseTypography } from '../utils/remarkNormalizeProseTypography.js';
import { transformMarkdownSource } from '../utils/transformMarkdownSource.js';
import { cn } from './lib/cn.js';
import type { OpenUiFenceBlockProps } from './OpenUiFenceBlock.js';
import type { SandboxArtifactDownloadProps } from './SandboxArtifactDownload.js';
import type { SyntaxHighlighterProps } from './SyntaxHighlighter.js';

/** Preloads OpenUiFenceBlock so it's ready before the user sees openui content. */
export function preloadMarkdownOpenUI(): Promise<unknown> {
  return import('./OpenUiFenceBlock.js');
}

/** Above this size, the still-growing streamed fence renders as plain code (Prism cost grows with body size); closed fences stay highlighted. */
export const LARGE_STREAMING_FENCE_CHARS = 8 * 1024;

export type MarkdownProps = {
  content: string;
  isStreaming?: boolean;
  /** Base URL for resolving sandbox artifact download paths (e.g. gateway file endpoint). */
  fileDownloadBaseUrl?: string;
  /** Custom download handler that receives the original sandbox artifact path. */
  onDownloadArtifact?: (path: string, filename: string) => Promise<void>;
  /** Handler to fetch file content for inlining in HTML previews. */
  onFetchFile?: (path: string) => Promise<Blob>;
  /** When true, download actions in sandbox artifact blocks are hidden/disabled. */
  readOnly?: boolean;
  /** Citation sources for resolving model-emitted citation markers like 【14†excerpts】. */
  citationSources?: Map<number, CitationSource> | CitationSource[] | null;
  className?: string;
};

/**
 * Body of the final unmatched fenced block while streaming, or null when every fence is closed.
 * Used so only the growing fence skips Prism; completed large fences stay highlighted.
 */
export function getActiveStreamingFenceCode(content: string): string | null {
  const re = /^(`{3,})([^\n]*)\n?/gm;
  const markers: Array<{ after: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    markers.push({ after: match.index + match[0].length });
  }
  if (markers.length % 2 === 0) return null;
  const open = markers[markers.length - 1];
  if (open == null) return null;
  return content.slice(open.after).replace(/\n$/, '');
}

function makeComponents(opts: {
  isStreaming?: boolean;
  /** Latest unmatched fence body; read via ref so `components` identity stays stable across growth. */
  getActiveFenceCode: () => string | null;
  darkTheme: boolean;
  fileDownloadBaseUrl?: string;
  onDownloadArtifact?: (path: string, filename: string) => Promise<void>;
  onFetchFile?: (path: string) => Promise<Blob>;
  readOnly?: boolean;
  OpenUiFenceBlock: ComponentType<OpenUiFenceBlockProps>;
  SandboxArtifactDownload: ComponentType<SandboxArtifactDownloadProps>;
  SyntaxHighlighter: ComponentType<SyntaxHighlighterProps>;
  inlineCodeClassName?: string;
}): Components {
  const {
    isStreaming,
    getActiveFenceCode,
    darkTheme,
    fileDownloadBaseUrl,
    onDownloadArtifact,
    onFetchFile,
    readOnly,
    OpenUiFenceBlock,
    SandboxArtifactDownload,
    SyntaxHighlighter,
    inlineCodeClassName,
  } = opts;

  return {
    // Drop every prop: hast-util-sanitize falls back to its universal attribute list for a tag
    // with an empty allowlist, so `br`'s schema entry alone would not stop e.g. `<br id="x">`.
    br() {
      return <br />;
    },
    // Chat markdown links should open in a new tab.
    a({ href, children, node: _node, ...props }) {
      return (
        <a {...props} href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
    // Strip default <pre> wrapper; each block renderer provides its own container.
    pre({ children }: { children?: ReactNode }) {
      return <>{children}</>;
    },
    code({ className, children }) {
      const language = /language-(\w+)/.exec(className ?? '')?.[1];
      const code = String(children ?? '').replace(/\n$/, '');

      // Inline code: no language class
      if (!className) {
        return (
          <code
            className={cn('aui-inline-code rounded bg-secondary-bg px-1 py-0.5 font-mono text-sm', inlineCodeClassName)}
          >
            {children}
          </code>
        );
      }

      if (language === 'openui') {
        return <OpenUiFenceBlock content={code} isStreaming={isStreaming} darkTheme={darkTheme} />;
      }

      if (language === 'sandbox_artifacts') {
        return (
          <SandboxArtifactDownload
            code={code}
            fileDownloadBaseUrl={fileDownloadBaseUrl}
            onDownloadArtifact={onDownloadArtifact}
            onFetchFile={onFetchFile}
            readOnly={readOnly}
          />
        );
      }

      // Only the unmatched growing fence skips Prism; closed fences stay highlighted.
      const activeFenceCode = getActiveFenceCode();
      const isActiveOversizedFence =
        isStreaming === true &&
        activeFenceCode != null &&
        code === activeFenceCode &&
        code.length > LARGE_STREAMING_FENCE_CHARS;

      if (isActiveOversizedFence) {
        return (
          <pre
            className={cn(
              'aui-syntax-highlighter my-2 max-w-full min-w-0 overflow-x-auto whitespace-pre-wrap break-words rounded-md',
            )}
            data-testid="aui-plain-streaming-fence"
          >
            <code className={cn(className, 'whitespace-pre-wrap break-words')}>{code}</code>
          </pre>
        );
      }

      return <SyntaxHighlighter code={code} language={language} darkTheme={darkTheme} />;
    },
  };
}

/**
 * Create remark plugins for markdown processing.
 * Math plugin has `singleDollarTextMath: false` to prevent ordinary prose dollar amounts
 * ("$5 and $10") from being mistaken for math. A `\( ... \)` from {@link transformMarkdownSource}
 * still opens inline math because it is rewritten to a double-dollar run, which remains
 * recognised regardless of this setting.
 * Citation markers plugin always runs: sources only control whether markers become links
 * (when a matching source with URL is found) or are removed.
 */
function createRemarkPlugins(citationSources?: Map<number, CitationSource> | CitationSource[] | null) {
  const plugins: PluggableList = [
    remarkGfm,
    remarkNormalizeProseTypography,
    [remarkMath, { singleDollarTextMath: false }],
  ];
  // Always add the citation markers plugin; it removes unresolved markers
  plugins.push([remarkCitationMarkers, citationSources]);
  return plugins;
}

/**
 * Tags that CommonMark and remark-gfm syntax (headings, emphasis, links, images, lists, task-list
 * checkboxes, blockquotes, code, tables, the thematic-break rule) legitimately turn into, plus
 * `br` for a literal `<br>` tag. `rehype-sanitize` cannot tell a tag that came from raw HTML the
 * user typed apart from one produced by normal markdown syntax; it sanitizes the whole tree
 * uniformly. So this list has to be everything ordinary markdown needs, not just `br`, or
 * `remark-gfm` output (bold text, links, lists, tables, ...) would be stripped down to plain text
 * along with the raw HTML we actually want to drop. Math tags are not in this list: `rehype-katex`
 * runs after sanitize (see `REHYPE_PLUGINS`) and builds its `span`/`svg`/`path` output directly, so
 * that output is never at risk of a raw `<span style=...>` slipping through unsanitized.
 */
const MARKDOWN_TAG_NAMES = [
  'p',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'em',
  'strong',
  'del',
  'a',
  'img',
  'ul',
  'ol',
  'li',
  'input',
  'blockquote',
  'code',
  'pre',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
];

/**
 * Sanitize schema for the `rehype-raw` + `rehype-sanitize` pipeline below. Starts from
 * `rehype-sanitize`'s default (GitHub-style) schema, restricted to {@link MARKDOWN_TAG_NAMES} so a
 * raw HTML tag not part of ordinary markdown output (`<div>`, `<script>`, an unknown tag, ...) is
 * dropped or unwrapped to its text content instead of rendered as a live element, and with `br`
 * given no allowed attributes at all. Everything else (allowed attributes per tag, URL protocol
 * allowlists, `script` fully stripped rather than unwrapped) is inherited from the default schema
 * unchanged, so a real markdown link, image, or table keeps working exactly as before.
 */
const MARKDOWN_SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: MARKDOWN_TAG_NAMES,
  attributes: {
    ...defaultSchema.attributes,
    br: [],
  },
};

// `rehype-katex` runs last, after sanitize: `remark-math` already turned math into `code`
// elements with a `language-math`/`math-inline`/`math-display` class (the default schema keeps
// `language-*` classes on `code`), so sanitize runs on ordinary, unprivileged markup only.
// `rehype-katex`'s `span`/`svg`/`path` output is built after that, so it is never sanitized and
// never needs allowlisting. `output: 'html'` skips the parallel MathML tree.
//
// Hosts must include KaTeX's own stylesheet (`katex/dist/katex.min.css`) for this output to lay
// out and size correctly; this package does not bundle it (see packages/frontend's Vite entry).
const REHYPE_PLUGINS: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA],
  [rehypeKatex, { output: 'html' }],
];

export function Markdown({
  content,
  isStreaming,
  fileDownloadBaseUrl,
  onDownloadArtifact,
  onFetchFile,
  readOnly,
  citationSources,
  className,
}: MarkdownProps) {
  const mode = useThemeMode();
  const classNames = useOptionalContentClassNames();
  const darkTheme = mode === 'dark';
  const OpenUiFenceBlock = useSlot('OpenUiFenceBlock');
  const SandboxArtifactDownload = useSlot('SandboxArtifactDownload');
  const SyntaxHighlighter = useSlot('SyntaxHighlighter');

  // Ref keeps `components` stable while the active fence grows so completed Prism trees do not remount.
  const activeFenceCodeRef = useRef<string | null>(null);
  activeFenceCodeRef.current = isStreaming === true ? getActiveStreamingFenceCode(content) : null;

  const components = useMemo(
    () =>
      makeComponents({
        isStreaming,
        getActiveFenceCode: () => activeFenceCodeRef.current,
        darkTheme,
        fileDownloadBaseUrl,
        onDownloadArtifact,
        onFetchFile,
        readOnly,
        OpenUiFenceBlock,
        SandboxArtifactDownload,
        SyntaxHighlighter,
        inlineCodeClassName: classNames.inlineCode,
      }),
    [
      isStreaming,
      darkTheme,
      fileDownloadBaseUrl,
      onDownloadArtifact,
      onFetchFile,
      readOnly,
      OpenUiFenceBlock,
      SandboxArtifactDownload,
      SyntaxHighlighter,
      classNames.inlineCode,
    ],
  );

  // Pre-parse source rewrites (LaTeX-style math delimiters, unicode-hyphen bullets; see
  // transformMarkdownSource.ts) applied before ReactMarkdown parses. The stored message is untouched.
  const transformedContent = useMemo(() => transformMarkdownSource(content), [content]);

  // Create remark plugins dynamically based on citation sources availability
  const remarkPlugins = useMemo(() => createRemarkPlugins(citationSources), [citationSources]);

  return (
    <div
      className={cn('aui-markdown markdown-body min-w-0 max-w-full overflow-x-clip', classNames.markdown, className)}
    >
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {transformedContent}
      </ReactMarkdown>
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    Markdown: typeof Markdown;
  }
}
