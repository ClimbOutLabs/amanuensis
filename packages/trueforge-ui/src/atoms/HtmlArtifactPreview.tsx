'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../icons/Icon.js';
import { cn } from './lib/cn.js';

export type HtmlArtifactPreviewProps = {
  /** HTML content blob to render. */
  content: Blob;
  /** Filename for display. */
  filename: string;
  /** Called to fetch related files (CSS, JS, images) from the same directory. */
  onFetchRelatedFile?: (path: string) => Promise<Blob>;
  /** Maximum total bytes to inline for related assets before falling back to link-only. */
  maxInliningBytes?: number;
  /**
   * Builds the host picture-proxy URL for one external picture. The proxy only serves links the
   * chat saw, so the frame itself never contacts an outside site: a proxied picture is inlined
   * as a data: URI, and anything the proxy refuses shows the plain line below. Absent, external
   * pictures stay out and show the space line instead.
   */
  pictureProxyUrl?: (url: string) => string;
  /** Saves the file to the user's device; only ever called from the download button. */
  onDownload?: () => void;
  /** When true, the download and expand controls are hidden. */
  readOnly?: boolean;
};

/** Shown where a picture would be when it cannot be shown. */
const PICTURE_FAILED_LINE = "This picture couldn't be shown";

/** Shown where a web picture would be when no picture proxy is available for this page. */
const SPACE_PICTURES_LINE = 'Pictures from the web show in a space';

const SCRIPT_TAG_RE = /<script[\s/>]/i;

const DEFAULT_MAX_INLINING_BYTES = 4 * 1024 * 1024; // 4 MB

/**
 * CSP meta tag policy for the sandboxed iframe.
 * - Allows inline styles from the document itself; scripts never run (the frame is sandboxed)
 * - Allows images and fonts from data: URIs only; nothing here can reach the network
 * - Blocks all network connections (connect-src falls back to default-src 'none')
 * - Blocks form posts and a rewritten base URL
 */
const CSP_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

/**
 * The wrapper frame carries the same policy plus a frame-src that only admits srcdoc frames. The
 * content frame inherits it, so content that sets `location` cannot load any URL, and its own CSP
 * meta can only tighten it.
 */
const WRAPPER_CSP_POLICY = `${CSP_POLICY}; frame-src about:`;

interface AssetToInline {
  originalUrl: string;
  type: 'stylesheet' | 'image';
  selector: string; // CSS selector to find and replace
}

/**
 * Extracts relative asset references from HTML content.
 * Returns paths to stylesheets and images that might need inlining (scripts never run, so they are not fetched).
 */
function extractRelativeAssets(htmlText: string): AssetToInline[] {
  const assets: AssetToInline[] = [];

  // Extract stylesheets: <link rel="stylesheet" href="...">
  const linkRe = /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(htmlText)) !== null) {
    const href = match[1];
    if (href && !href.startsWith('http://') && !href.startsWith('https://')) {
      assets.push({
        originalUrl: href,
        type: 'stylesheet',
        selector: `link[href="${href}"]`,
      });
    }
  }

  // Extract images: <img src="...">
  const imgRe = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/g;
  while ((match = imgRe.exec(htmlText)) !== null) {
    const src = match[1];
    if (src && !src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('data:')) {
      assets.push({
        originalUrl: src,
        type: 'image',
        selector: `img[src="${src}"]`,
      });
    }
  }

  return assets;
}

/**
 * Resolves a relative path to an absolute artifact path.
 * E.g. given originalPath="/tmp/dir/index.html" and relativePath="style.css",
 * returns "/tmp/dir/style.css".
 */
function resolveAssetPath(originalPath: string, relativePath: string): string {
  const dir = originalPath.split('/').slice(0, -1).join('/');
  return `${dir}/${relativePath}`;
}

async function blobToText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') {
    return blob.text();
  }
  // Fallback for environments where Blob.text() is not available
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(blob);
  });
}

/**
 * Attempts to inline relative assets into the HTML document.
 * Returns the modified HTML and total bytes inlined.
 */
async function inlineAssets(
  htmlText: string,
  originalPath: string,
  onFetchRelatedFile: (path: string) => Promise<Blob>,
  maxInliningBytes: number,
): Promise<{ html: string; bytesInlined: number }> {
  const assets = extractRelativeAssets(htmlText);
  let modifiedHtml = htmlText;
  let bytesInlined = 0;

  for (const asset of assets) {
    if (bytesInlined >= maxInliningBytes) break;

    try {
      const assetPath = resolveAssetPath(originalPath, asset.originalUrl);
      const assetBlob = await onFetchRelatedFile(assetPath);
      const assetSize = assetBlob.size;

      if (bytesInlined + assetSize > maxInliningBytes) continue;

      const assetText = await blobToText(assetBlob);
      bytesInlined += assetSize;

      if (asset.type === 'stylesheet') {
        // Find and replace the actual <link> tag with <style>
        // Match <link ...href="...style.css"...>
        const escapedUrl = escapeRegex(asset.originalUrl);
        const linkPattern = new RegExp(`<link\\s+[^>]*href=["']([^"']*/)?${escapedUrl}["'][^>]*\\s*/?>`, 'gi');
        const styleTag = `<style>${assetText}</style>`;
        modifiedHtml = modifiedHtml.replace(linkPattern, () => styleTag);
      } else if (asset.type === 'image') {
        // Convert image to data URI
        const dataUri = await blobToDataUri(assetBlob);
        const escapedUrl = escapeRegex(asset.originalUrl);
        const imgPattern = new RegExp(`src=["']([^"']*/)?${escapedUrl}["']`, 'gi');
        modifiedHtml = modifiedHtml.replace(imgPattern, () => `src="${dataUri}"`);
      }
    } catch (error) {
      // Skip assets that fail to load
      console.warn(`Failed to inline asset ${asset.originalUrl}:`, error);
    }
  }

  return { html: modifiedHtml, bytesInlined };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const EXTERNAL_IMG_TAG_RE = /<img\s+[^>]*>/gi;
const SRC_ATTR_RE = /\ssrc=["']([^"']+)["']/i;

/**
 * Inlines external pictures through the host picture proxy, keeping the frame's data:-only
 * picture rule intact: the frame never fetches an outside URL, it only ever sees data: URIs the
 * app origin fetched for it. A picture the proxy refuses (unseen in this chat, or unfetchable)
 * becomes the plain failure line, and without a proxy every web picture becomes the space line.
 * Bytes count against the same inlining budget as related assets.
 */
async function inlineExternalImages(
  htmlText: string,
  pictureProxyUrl: ((url: string) => string) | undefined,
  maxBytes: number,
): Promise<{ html: string; bytesInlined: number }> {
  let out = '';
  let copied = 0;
  let bytesInlined = 0;
  EXTERNAL_IMG_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXTERNAL_IMG_TAG_RE.exec(htmlText)) !== null) {
    const tag = match[0];
    const srcMatch = SRC_ATTR_RE.exec(tag);
    const src = srcMatch?.[1];
    if (src === undefined || !/^https?:\/\//i.test(src)) {
      continue;
    }
    out += htmlText.slice(copied, match.index);
    copied = match.index + tag.length;
    if (pictureProxyUrl === undefined) {
      out += `<span>${SPACE_PICTURES_LINE}</span>`;
      continue;
    }
    try {
      const response = await fetch(pictureProxyUrl(src));
      if (!response.ok) {
        throw new Error(`Picture proxy refused ${response.status}`);
      }
      const blob = await response.blob();
      if (bytesInlined + blob.size > maxBytes) {
        throw new Error('Picture exceeds the inlining budget');
      }
      const dataUri = await blobToDataUri(blob);
      bytesInlined += blob.size;
      out += tag.replace(SRC_ATTR_RE, () => ` src="${dataUri}"`);
    } catch {
      out += `<span>${PICTURE_FAILED_LINE}</span>`;
    }
  }
  return { html: out + htmlText.slice(copied), bytesInlined };
}

async function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, char => map[char] || char);
}

const META_START_RE = /<meta/gi;
const HTTP_EQUIV_ATTR_RE = /[\s/]http-equiv\b/i;

/**
 * Removes every `<meta http-equiv>` from the content: refresh would navigate the frame away on its
 * own, and attribute values can be entity-encoded, so matching on "refresh" is not reliable.
 * Single pass: each tag is walked once, honoring quotes so a ">" in a value cannot end it early,
 * and an unterminated tag ends the scan.
 */
function stripHttpEquivMetas(htmlText: string): string {
  let out = '';
  let copied = 0;
  META_START_RE.lastIndex = 0;
  for (let start = META_START_RE.exec(htmlText); start !== null; start = META_START_RE.exec(htmlText)) {
    let quote: string | null = null;
    let end = start.index + '<meta'.length;
    for (; end < htmlText.length; end++) {
      const char = htmlText[end];
      if (quote !== null) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
    }
    if (end >= htmlText.length) break;
    const tag = htmlText.slice(start.index, end + 1);
    if (HTTP_EQUIV_ATTR_RE.test(tag)) {
      out += htmlText.slice(copied, start.index);
      copied = end + 1;
    }
    META_START_RE.lastIndex = end + 1;
  }
  return out + htmlText.slice(copied);
}

const POLICY_PREFIX = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${escapeHtml(CSP_POLICY)}" />`;

/**
 * Puts a doctype and the app's CSP meta ahead of the content, which is appended unchanged.
 * The content is never scanned: comment-like prefixes can hide script from any marker search.
 * A later doctype is ignored, and later metas can only tighten this policy.
 */
function insertPolicyFirst(htmlText: string): string {
  return `${POLICY_PREFIX}${htmlText}`;
}

/**
 * Wraps the page in a frame whose CSP only admits srcdoc children, so the page cannot navigate
 * its own frame to a URL. Both frames are fully sandboxed: scripts never run, because nothing in a
 * CSP stops a running script from sending data out over WebRTC.
 */
function wrapInContainmentFrame(html: string): string {
  return [
    '<!doctype html>',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(WRAPPER_CSP_POLICY)}">`,
    '<style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style>',
    `<iframe sandbox="" referrerpolicy="no-referrer" srcdoc="${escapeHtml(html)}"></iframe>`,
  ].join('');
}

export function HtmlArtifactPreview({
  content,
  filename,
  onFetchRelatedFile,
  maxInliningBytes = DEFAULT_MAX_INLINING_BYTES,
  pictureProxyUrl,
  onDownload,
  readOnly,
}: HtmlArtifactPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [srcdoc, setSrcdoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [bytesInlined, setBytesInlined] = useState(0);
  const [usesScripts, setUsesScripts] = useState(false);

  // Convert blob to string and inline assets
  useEffect(() => {
    let isMounted = true;

    async function prepare() {
      try {
        let htmlText = await blobToText(content);
        if (isMounted) setUsesScripts(SCRIPT_TAG_RE.test(htmlText));

        htmlText = insertPolicyFirst(stripHttpEquivMetas(htmlText));

        // Inline relative assets if fetch function is provided
        let inlinedBytes = 0;
        if (onFetchRelatedFile) {
          const { html: inlinedHtml, bytesInlined: bytes } = await inlineAssets(
            htmlText,
            `/tmp/${filename}`, // Mock path for asset resolution
            onFetchRelatedFile,
            maxInliningBytes,
          );
          htmlText = inlinedHtml;
          inlinedBytes = bytes;
        }

        // External pictures go through the host proxy and are inlined the same way, so the
        // frame's data:-only rule never changes.
        const { html: proxiedHtml, bytesInlined: proxiedBytes } = await inlineExternalImages(
          htmlText,
          pictureProxyUrl,
          maxInliningBytes - inlinedBytes,
        );
        htmlText = proxiedHtml;
        if (isMounted) setBytesInlined(inlinedBytes + proxiedBytes);

        if (isMounted) {
          setSrcdoc(htmlText);
          setError(null);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to prepare HTML content');
        }
      }
    }

    prepare();

    return () => {
      isMounted = false;
    };
  }, [content, filename, onFetchRelatedFile, maxInliningBytes, pictureProxyUrl]);

  const framedSrcdoc = useMemo(() => (srcdoc == null ? null : wrapInContainmentFrame(srcdoc)), [srcdoc]);

  if (error) {
    return (
      <div
        className="aui-html-preview my-2 rounded-lg border border-border bg-card-bg p-3 text-sm text-text-secondary"
        data-testid="aui-html-preview-error"
      >
        Failed to render HTML preview: {error}
      </div>
    );
  }

  if (framedSrcdoc == null) {
    return (
      <div
        className="aui-html-preview my-2 rounded-lg border border-border bg-card-bg p-3 text-sm text-text-secondary"
        data-testid="aui-html-preview-loading"
      >
        Loading preview...
      </div>
    );
  }

  const previewHeight = isExpanded ? '75vh' : '25rem';

  return (
    <div
      className="aui-html-preview group my-2 overflow-hidden rounded-lg border border-primary-button-bg/20 bg-card-bg"
      data-testid="aui-html-preview"
    >
      {/* Header with title and controls */}
      <div className="flex items-center justify-between gap-2 bg-primary-button-bg/5 px-3 py-2 text-xs font-medium leading-none text-primary-button-bg">
        <div className="flex items-center gap-2 overflow-hidden">
          <Icon name="file" size={16} className="shrink-0" />
          <span className="truncate leading-none">{filename}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!readOnly && (
            <>
              {onDownload && (
                <button
                  onClick={onDownload}
                  className={cn(
                    'inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors',
                    'hover:bg-primary-button-bg/10 active:bg-primary-button-bg/20',
                  )}
                  title="Download"
                  aria-label={`Download ${filename}`}
                >
                  <Icon name="download" size={12} className="shrink-0" />
                </button>
              )}
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors',
                  'hover:bg-primary-button-bg/10 active:bg-primary-button-bg/20',
                )}
                title={isExpanded ? 'Collapse' : 'Expand'}
                aria-label={isExpanded ? `Collapse ${filename}` : `Expand ${filename}`}
              >
                <Icon name="expand" size={12} className="shrink-0" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Preview iframe */}
      <div className="relative min-h-96 bg-card-bg" style={{ height: previewHeight, overflow: 'auto' }}>
        <iframe
          ref={iframeRef}
          srcDoc={framedSrcdoc}
          title={`Preview of ${filename}`}
          className="h-full w-full border-0"
          sandbox=""
          referrerPolicy="no-referrer"
          data-testid="aui-html-preview-iframe"
        />
      </div>

      {usesScripts && (
        <div className="bg-primary-button-bg/5 px-3 py-1 text-xs text-text-secondary">
          This page uses scripts, which previews don't run, so parts of it may look blank or unfinished.
        </div>
      )}

      {/* Footer with info */}
      {!readOnly && (
        <div className="bg-primary-button-bg/5 px-3 py-1 text-xs text-text-secondary">
          {bytesInlined > 0 && <span>Inlined {bytesInlined} bytes of related assets</span>}
        </div>
      )}
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    HtmlArtifactPreview: typeof HtmlArtifactPreview;
  }
}
