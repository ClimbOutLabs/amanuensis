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
  readOnly,
}: SandboxArtifactDownloadProps) {
  const ChatFileDownload = useSlot('ChatFileDownload');
  const artifacts = useMemo(() => parseSandboxArtifacts(code), [code]);
  if (artifacts.length === 0) {
    // Nothing parsed: show the raw block instead of an empty reply, so the user
    // at least sees what the model wrote.
    return (
      <pre
        data-testid="aui-sandbox-artifacts-raw"
        className="aui-sandbox-artifacts-raw my-2 overflow-x-auto rounded-lg border border-border bg-card-bg p-3 font-mono text-sm text-text-secondary"
      >
        {code}
      </pre>
    );
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
  readOnly,
}: {
  artifact: SandboxArtifact;
  onDownloadArtifact: (path: string, filename: string) => Promise<void>;
  onFetchFile: (path: string) => Promise<Blob>;
  readOnly?: boolean;
}) {
  const HtmlArtifactPreview = useSlot('HtmlArtifactPreview');
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function fetchAndPrepare() {
      try {
        // First trigger the download (this logs the action)
        await onDownloadArtifact(artifact.path, artifact.name);

        // Then fetch the file blob
        if (isMounted) {
          const fileBlob = await onFetchFile(artifact.path);
          if (isMounted) {
            setBlob(fileBlob);
            setError(null);
          }
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
  }, [artifact, onDownloadArtifact, onFetchFile]);

  if (error) {
    return (
      <div className="aui-html-preview-error my-2 rounded-lg border border-border bg-card-bg p-3 text-sm text-text-secondary">
        Failed to load {artifact.name}: {error}
      </div>
    );
  }

  if (!blob) return null;

  return (
    <HtmlArtifactPreview content={blob} filename={artifact.name} onFetchRelatedFile={onFetchFile} readOnly={readOnly} />
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    SandboxArtifactDownload: typeof SandboxArtifactDownload;
  }
}
