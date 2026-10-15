'use client';

import { useEffect, useRef, useState } from 'react';

import { Icon } from '../icons/Icon.js';
import { cn } from './lib/cn.js';

export type HtmlArtifactPreviewProps = {
  /** HTML content blob to render. */
  content: Blob;
  /** Filename for display and new tab. */
  filename: string;
  /** Called to fetch related files (CSS, JS, images) from the same directory. */
  onFetchRelatedFile?: (path: string) => Promise<Blob>;
  /** Maximum total bytes to inline for related assets before falling back to link-only. */
  maxInliningBytes?: number;
  /** When true, only the download link is shown (no preview). */
  readOnly?: boolean;
};

const DEFAULT_MAX_INLINING_BYTES = 4 * 1024 * 1024; // 4 MB

/**
 * CSP meta tag policy for the sandboxed iframe.
 * - Allows inline scripts and styles from the document itself
 * - Allows images from data: URIs only; fonts from data: URIs and https: URLs
 * - Blocks all network connections (connect-src none)
 * - Blocks framing
 */
const CSP_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data: https:; frame-ancestors 'none'";

interface AssetToInline {
  originalUrl: string;
  type: 'stylesheet' | 'script' | 'image';
  selector: string; // CSS selector to find and replace
}

/**
 * Extracts relative asset references from HTML content.
 * Returns paths to stylesheets, scripts, and images that might need inlining.
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

  // Extract scripts: <script src="...">
  const scriptRe = /<script\s+[^>]*src=["']([^"']+)["'][^>]*><\/script>/g;
  while ((match = scriptRe.exec(htmlText)) !== null) {
    const src = match[1];
    if (src && !src.startsWith('http://') && !src.startsWith('https://')) {
      assets.push({
        originalUrl: src,
        type: 'script',
        selector: `script[src="${src}"]`,
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
        modifiedHtml = modifiedHtml.replace(linkPattern, styleTag);
      } else if (asset.type === 'script') {
        // Replace <script src="..."></script> with <script>...</script>
        const escapedUrl = escapeRegex(asset.originalUrl);
        const scriptPattern = new RegExp(
          `<script\\s+[^>]*src=["']([^"']*/)?${escapedUrl}["'][^>]*>\\s*</script>`,
          'gi',
        );
        const scriptTag = `<script>${assetText}</script>`;
        modifiedHtml = modifiedHtml.replace(scriptPattern, scriptTag);
      } else if (asset.type === 'image') {
        // Convert image to data URI
        const dataUri = await blobToDataUri(assetBlob);
        const escapedUrl = escapeRegex(asset.originalUrl);
        const imgPattern = new RegExp(`src=["']([^"']*/)?${escapedUrl}["']`, 'gi');
        modifiedHtml = modifiedHtml.replace(imgPattern, `src="${dataUri}"`);
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

export function HtmlArtifactPreview({
  content,
  filename,
  onFetchRelatedFile,
  maxInliningBytes = DEFAULT_MAX_INLINING_BYTES,
  readOnly,
}: HtmlArtifactPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [srcdoc, setSrcdoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [bytesInlined, setBytesInlined] = useState(0);

  // Convert blob to string and inline assets
  useEffect(() => {
    let isMounted = true;

    async function prepare() {
      try {
        let htmlText = await blobToText(content);

        // Inject CSP meta tag at the top of the document
        if (!htmlText.includes('<meta http-equiv="Content-Security-Policy"')) {
          const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(CSP_POLICY)}" />`;
          // Find insertion point after <head> or at document start
          const headMatch = htmlText.match(/<head[^>]*>/i);
          if (headMatch) {
            htmlText = htmlText.replace(headMatch[0], headMatch[0] + '\n' + cspMeta);
          } else {
            const htmlMatch = htmlText.match(/<html[^>]*>/i);
            if (htmlMatch) {
              htmlText = htmlText.replace(htmlMatch[0], htmlMatch[0] + '\n<head>' + cspMeta + '</head>');
            } else {
              htmlText = cspMeta + '\n' + htmlText;
            }
          }
        }

        // Inline relative assets if fetch function is provided
        if (onFetchRelatedFile) {
          const { html: inlinedHtml, bytesInlined: bytes } = await inlineAssets(
            htmlText,
            `/tmp/${filename}`, // Mock path for asset resolution
            onFetchRelatedFile,
            maxInliningBytes,
          );
          htmlText = inlinedHtml;
          if (isMounted) setBytesInlined(bytes);
        }

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
  }, [content, filename, onFetchRelatedFile, maxInliningBytes]);

  // Open HTML in new tab via Blob URL
  const handleOpenInNewTab = () => {
    if (srcdoc == null) return;
    const blob = new Blob([srcdoc], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    // Note: URL.revokeObjectURL is not called here to allow the tab to load;
    // browsers clean up automatically when the tab closes
  };

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

  if (srcdoc == null) {
    return (
      <div
        className="aui-html-preview my-2 rounded-lg border border-border bg-card-bg p-3 text-sm text-text-secondary"
        data-testid="aui-html-preview-loading"
      >
        Loading preview...
      </div>
    );
  }

  const previewHeight = isExpanded ? '600px' : '400px';

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
              <button
                onClick={handleOpenInNewTab}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors',
                  'hover:bg-primary-button-bg/10 active:bg-primary-button-bg/20',
                )}
                title="Open in new tab"
                aria-label={`Open ${filename} in new tab`}
              >
                <Icon name="external-link" size={12} className="shrink-0" />
              </button>
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
          srcDoc={srcdoc}
          title={`Preview of ${filename}`}
          className="h-full w-full border-0"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          data-testid="aui-html-preview-iframe"
        />
      </div>

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
