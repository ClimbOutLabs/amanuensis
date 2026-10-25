'use client';

import { parseSandboxArtifacts as parseSandboxArtifactsShared } from '@truefoundry/trueforge-core/core/sandbox/sandboxArtifacts';
import { useEffect, useMemo, useState } from 'react';

import { useSlot } from '../theme/SlotsProvider.js';
import type { ChatFileDownloadFile } from './ChatFileDownload.js';

export type SandboxArtifactDownloadProps = {
  code: string;
  fileDownloadBaseUrl?: string;
  onDownloadArtifact?: (path: string, filename: string) => Promise<void>;
  onFetchFile?: (path: string) => Promise<Blob>;
  /** Builds the host picture-proxy URL for one external picture on a chat page; see HtmlArtifactPreview. */
  pictureProxyUrl?: (url: string) => string;
  readOnly?: boolean;
};

export type SandboxArtifact = ChatFileDownloadFile;

/**
 * Re-exported for backward compatibility with existing imports of this module; the
 * implementation lives in `@truefoundry/trueforge-core/core` so the host (turn-completion
 * artifact persistence) and this UI parse the model's `sandbox_artifacts` declaration
 * identically.
 */
export const parseSandboxArtifacts = parseSandboxArtifactsShared;

function isHtmlFile(filename: string): boolean {
  return filename.toLowerCase().endsWith('.html') || filename.toLowerCase().endsWith('.htm');
}

export function SandboxArtifactDownload({
  code,
  fileDownloadBaseUrl,
  onDownloadArtifact,
  onFetchFile,
  pictureProxyUrl,
  readOnly,
}: SandboxArtifactDownloadProps) {
  const ChatFileDownload = useSlot('ChatFileDownload');
  const artifacts = useMemo(() => parseSandboxArtifacts(code), [code]);
  if (artifacts.length === 0) {
    // A block naming no file shows nothing: its raw text means nothing to the person reading.
    return null;
  }

  // Check if there are any HTML artifacts to preview
  const htmlArtifacts = artifacts.filter(a => isHtmlFile(a.name));
  const nonHtmlArtifacts = artifacts.filter(a => !isHtmlFile(a.name));

  return (
    <>
      {/* Render HTML artifacts as inline previews */}
      {htmlArtifacts.length > 0 && onDownloadArtifact && onFetchFile && (
        <div className="space-y-2">
          {htmlArtifacts.map(artifact => (
            <HtmlArtifactPreviewWrapper
              key={artifact.path}
              artifact={artifact}
              onDownloadArtifact={onDownloadArtifact}
              onFetchFile={onFetchFile}
              pictureProxyUrl={pictureProxyUrl}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}

      {/* Render HTML artifacts as links if preview not available, plus all non-HTML artifacts */}
      {(htmlArtifacts.length === 0 || !onDownloadArtifact || !onFetchFile) && (
        <ChatFileDownload
          files={artifacts}
          fileDownloadBaseUrl={fileDownloadBaseUrl}
          onDownloadArtifact={onDownloadArtifact}
          readOnly={readOnly}
        />
      )}

      {/* If we showed HTML previews, also show links for non-HTML artifacts */}
      {htmlArtifacts.length > 0 && nonHtmlArtifacts.length > 0 && onDownloadArtifact && onFetchFile && (
        <ChatFileDownload
          files={nonHtmlArtifacts}
          fileDownloadBaseUrl={fileDownloadBaseUrl}
          onDownloadArtifact={onDownloadArtifact}
          readOnly={readOnly}
        />
      )}
    </>
  );
}

function HtmlArtifactPreviewWrapper({
  artifact,
  onDownloadArtifact,
  onFetchFile,
  pictureProxyUrl,
  readOnly,
}: {
  artifact: SandboxArtifact;
  onDownloadArtifact: (path: string, filename: string) => Promise<void>;
  onFetchFile: (path: string) => Promise<Blob>;
  pictureProxyUrl?: (url: string) => string;
  readOnly?: boolean;
}) {
  const HtmlArtifactPreview = useSlot('HtmlArtifactPreview');
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function fetchAndPrepare() {
      try {
        // Display only: saving to the user's device waits for an explicit download click.
        const fileBlob = await onFetchFile(artifact.path);
        if (isMounted) {
          setBlob(fileBlob);
          setError(null);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to load HTML artifact');
        }
      }
    }

    fetchAndPrepare();

    return () => {
      isMounted = false;
    };
  }, [artifact, onFetchFile]);

  if (error) {
    return (
      <div className="aui-html-preview-error my-2 rounded-lg border border-border bg-card-bg p-3 text-sm text-text-secondary">
        Failed to load {artifact.name}: {error}
      </div>
    );
  }

  if (!blob) return null;

  return (
    <HtmlArtifactPreview
      content={blob}
      filename={artifact.name}
      onFetchRelatedFile={onFetchFile}
      pictureProxyUrl={pictureProxyUrl}
      onDownload={() => {
        onDownloadArtifact(artifact.path, artifact.name).catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Failed to download HTML artifact');
        });
      }}
      readOnly={readOnly}
    />
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    SandboxArtifactDownload: typeof SandboxArtifactDownload;
  }
}
