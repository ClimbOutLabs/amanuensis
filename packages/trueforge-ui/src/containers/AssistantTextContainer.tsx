'use client';

import {
  useAuiState,
  useSmooth,
  type MessagePartState,
  type ReasoningMessagePart,
  type TextMessagePart,
} from '@assistant-ui/react';
import { useTrueFoundryDownloadSandboxFile } from '@truefoundry/assistant-ui-runtime';
import { useCallback, useMemo, useRef } from 'react';

import { MARKDOWN_SMOOTH_BACKLOG_CHARS, useThrottledMarkdownText } from '../hooks/useThrottledMarkdownText.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { extractSearchCitationSources, type CitationToolCall } from '../utils/citationMarkers.js';
import { useToasterOptional } from './ToasterContainer.js';

function filenameFromPath(path: string): string {
  return path.split('/').pop() || 'download';
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AssistantTextContainer() {
  const Markdown = useSlot('Markdown');
  const toaster = useToasterOptional();
  const downloadSandboxFile = useTrueFoundryDownloadSandboxFile();
  // The download closure changes as the turn streams; a ref keeps handlers stable so
  // OpenUI does not remount.
  const downloadRef = useRef({ downloadSandboxFile, toaster });
  downloadRef.current = { downloadSandboxFile, toaster };
  const partState = useAuiState(s => s.part as MessagePartState & (TextMessagePart | ReasoningMessagePart));
  const messageParts = useAuiState(s => s.message.parts);

  // Citation sources for model-emitted markers like 【14†excerpts】: the same message's
  // web_search / web_fetch results carry the ID→title mapping the model cited against.
  // Null when the message ran no searches, preserving the previous rendering exactly.
  const citationSources = useMemo(() => {
    const calls: CitationToolCall[] = [];
    for (const part of messageParts) {
      if (part.type !== 'tool-call') {
        continue;
      }
      calls.push({ toolName: part.toolName, argsText: part.argsText, result: part.result });
    }
    const sources = extractSearchCitationSources(calls);
    return sources.length > 0 ? sources : null;
  }, [messageParts]);

  // Preserve the typewriter effect while it keeps pace. If its visible prefix falls too far
  // behind the raw stream, latch this part into bounded latest-prefix snapshots instead of
  // animating an ever-growing queue. We intentionally do not re-enable useSmooth for this part:
  // its private cursor still points at the old prefix and could visibly rewind the message.
  const pacedModeRef = useRef(false);
  const smoothedPart = useSmooth(
    partState,
    pacedModeRef.current
      ? false
      : {
          drainMs: 150,
          maxCharIntervalMs: 4,
          maxCharsPerFrame: 128,
          minCommitMs: 48,
        },
  );

  const networkComplete = partState.status?.type !== 'running';
  const smoothLag = partState.text.length - smoothedPart.text.length;
  if (!pacedModeRef.current && !networkComplete && smoothLag >= MARKDOWN_SMOOTH_BACKLOG_CHARS) {
    pacedModeRef.current = true;
  }
  const usePacedMode = pacedModeRef.current;

  const pacedText = useThrottledMarkdownText(partState.text, {
    enabled: usePacedMode,
    isComplete: networkComplete,
  });

  const text = usePacedMode ? pacedText : smoothedPart.text;
  // true while network stream is active OR while reveal/paced commit is still catching up
  const isStreaming = usePacedMode
    ? !networkComplete || text !== partState.text
    : smoothedPart.status?.type === 'running';

  const handleDownloadArtifact = useCallback(async (path: string) => {
    const { downloadSandboxFile, toaster } = downloadRef.current;
    try {
      triggerBrowserDownload(await downloadSandboxFile(path), filenameFromPath(path));
    } catch (error) {
      if (toaster != null) {
        toaster.showError(error);
      } else {
        console.error('Failed to download sandbox artifact', error);
      }
    }
  }, []);

  const handleFetchFile = useCallback(async (path: string): Promise<Blob> => {
    const { downloadSandboxFile } = downloadRef.current;
    return downloadSandboxFile(path);
  }, []);

  // Skip markdown re-parse when a raw SSE tick did not advance the committed display text.
  return useMemo(
    () => (
      <Markdown
        content={text}
        isStreaming={isStreaming}
        onDownloadArtifact={handleDownloadArtifact}
        onFetchFile={handleFetchFile}
        citationSources={citationSources}
      />
    ),
    [Markdown, text, isStreaming, handleDownloadArtifact, handleFetchFile, citationSources],
  );
}
