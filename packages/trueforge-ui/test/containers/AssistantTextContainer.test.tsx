// @vitest-environment jsdom
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { trueFoundryExtras } from '@truefoundry/assistant-ui-runtime';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { MarkdownProps } from '@/atoms/Markdown.js';
import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { ToasterProvider } from '@/containers/ToasterContainer.js';
import { LARGE_MARKDOWN_THROTTLE_MS, MARKDOWN_SMOOTH_BACKLOG_CHARS } from '@/hooks/useThrottledMarkdownText.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';
import { RuntimeHarness } from './RuntimeHarness.js';

function renderAssistantMessage(messages: ThreadMessageLike[]) {
  return render(
    <RuntimeHarness messages={messages}>
      <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
    </RuntimeHarness>,
  );
}

describe('AssistantTextContainer', () => {
  it('renders markdown formatting from the live text part', () => {
    renderAssistantMessage([{ role: 'assistant', content: '**bold** text' }]);
    const strong = screen.getByText('bold');
    expect(strong.tagName).toBe('STRONG');
  });

  it('renders plain streaming text as it grows', () => {
    renderAssistantMessage([{ role: 'assistant', content: 'partial toke' }]);
    expect(screen.getByText('partial toke')).toBeInTheDocument();
  });

  it('renders openui fenced blocks via OpenUiFenceBlock instead of a code pre', async () => {
    renderAssistantMessage([
      {
        role: 'assistant',
        content: '```openui\nCard() { title: "Sales" }\n```',
      },
    ]);
    // Lazy import resolves asynchronously; wait for Suspense to settle.
    await waitFor(() => {
      expect(screen.getByTestId('aui-openui-renderer')).toBeInTheDocument();
    });
    expect(screen.getByTestId('aui-openui-renderer')).toHaveTextContent('Card() { title: "Sales" }');
    expect(document.querySelector('.code-block-header')).not.toBeInTheDocument();
  });

  it('passes the runtime-backed artifact download handler to markdown', () => {
    function Markdown({ onDownloadArtifact }: MarkdownProps) {
      return <div data-testid="artifact-download-handler">{typeof onDownloadArtifact}</div>;
    }

    render(
      <RuntimeHarness messages={[{ role: 'assistant', content: 'artifact' }]}>
        <SlotsProvider overrides={{ Markdown }}>
          <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
        </SlotsProvider>
      </RuntimeHarness>,
    );

    expect(screen.getByTestId('artifact-download-handler')).toHaveTextContent('function');
  });

  describe('lag-triggered markdown pacing', () => {
    it('shows finished small markdown immediately without paced throttling', () => {
      const commits: string[] = [];

      function TrackingMarkdown({ content }: MarkdownProps) {
        commits.push(content);
        return <div data-testid="smooth-markdown">{content}</div>;
      }

      render(
        <RuntimeHarness messages={[{ role: 'assistant', content: 'hello world' }]} isRunning={false}>
          <SlotsProvider overrides={{ Markdown: TrackingMarkdown }}>
            <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
          </SlotsProvider>
        </RuntimeHarness>,
      );

      expect(commits[commits.length - 1]).toBe('hello world');
      expect(commits[commits.length - 1]!.length).toBeLessThan(MARKDOWN_SMOOTH_BACKLOG_CHARS);
    });

    it('latches paced mode after a smooth backlog and flushes on completion', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });

      try {
        const commits: string[] = [];

        // Long mixed markdown so a running dump creates an immediate smooth backlog.
        const line = (i: number) =>
          i % 40 === 0 ? `\`\`\`js\nconst block_${i} = ${i};\n\`\`\`` : `Paragraph line ${i} with some filler text.`;
        const base = Array.from({ length: 200 }, (_, i) => line(i)).join('\n');
        expect(base.length).toBeGreaterThan(MARKDOWN_SMOOTH_BACKLOG_CHARS);

        let setContent!: (value: string) => void;
        let setRunning!: (value: boolean) => void;

        function TrackingMarkdown({ content }: MarkdownProps) {
          commits.push(content);
          return <div data-testid="paced-markdown">{content.length}</div>;
        }

        function Case() {
          const [content, setContentState] = useState(base);
          const [isRunning, setIsRunningState] = useState(true);
          setContent = setContentState;
          setRunning = setIsRunningState;

          const messages: ThreadMessageLike[] = [
            {
              id: 'assistant-large-md',
              role: 'assistant',
              content: [{ type: 'text', text: content }],
            },
          ];

          const runtime = useExternalStoreRuntime({
            messages,
            isRunning,
            convertMessage: message => message,
            onNew: async () => {},
          });

          return (
            <AssistantRuntimeProvider runtime={runtime}>
              <SlotsProvider overrides={{ Markdown: TrackingMarkdown }}>
                <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
              </SlotsProvider>
            </AssistantRuntimeProvider>
          );
        }

        render(<Case />);

        // Running dump starts with empty smooth cursor → backlog ≥ 4KB → paced seed to latest.
        expect(commits[commits.length - 1]).toBe(base);
        const afterLatchCommits = commits.length;

        const grown = `${base}\nextra-${'x'.repeat(64)}`;
        await act(async () => {
          vi.advanceTimersByTime(10);
          setContent(grown);
          await Promise.resolve();
        });

        // Inside the throttle window — display must not advance yet.
        expect(commits[commits.length - 1]).toBe(base);
        expect(commits.length).toBe(afterLatchCommits);

        await act(async () => {
          vi.advanceTimersByTime(LARGE_MARKDOWN_THROTTLE_MS);
          await Promise.resolve();
        });
        expect(commits[commits.length - 1]).toBe(grown);

        const finalText = `${grown}\nDONE`;
        await act(async () => {
          setContent(finalText);
          setRunning(false);
          await Promise.resolve();
        });

        expect(commits[commits.length - 1]).toBe(finalText);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('paced mode across messages', () => {
    const base = Array.from({ length: 200 }, (_, i) => `Paragraph line ${i} with some filler text.`).join('\n');

    function setup() {
      const commits: string[] = [];
      let setMessages!: (messages: ThreadMessageLike[]) => void;

      function TrackingMarkdown({ content }: MarkdownProps) {
        commits.push(content);
        return <div data-testid="paced-markdown">{content.length}</div>;
      }

      function Case() {
        const [messages, setMessagesState] = useState<ThreadMessageLike[]>([
          { id: 'a', role: 'assistant', content: [{ type: 'text', text: base }] },
        ]);
        setMessages = setMessagesState;
        return (
          <RuntimeHarness messages={messages} isRunning>
            <SlotsProvider overrides={{ Markdown: TrackingMarkdown }}>
              <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
            </SlotsProvider>
          </RuntimeHarness>
        );
      }

      render(<Case />);
      // The initial running dump exceeds the smooth backlog, so the part latches into paced mode.
      expect(commits[commits.length - 1]).toBe(base);
      return { commits, setMessages };
    }

    async function withFakeTimers(run: () => Promise<void>) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
      try {
        await run();
      } finally {
        vi.useRealTimers();
      }
    }

    it('restarts the reveal for a regenerated message at the same position with a new id', async () => {
      await withFakeTimers(async () => {
        const { commits, setMessages } = setup();
        const before = commits.length;

        await act(async () => {
          setMessages([{ id: 'b', role: 'assistant', content: [{ type: 'text', text: 'fresh reply' }] }]);
          await Promise.resolve();
        });

        // The latch is released, so the new message re-enters the typewriter instead of
        // jumping straight to a paced snapshot, and never shows text from the old message.
        const after = commits.slice(before);
        expect(after[0]).not.toBe('fresh reply');
        expect(after.some(content => content.length > 0 && base.startsWith(content))).toBe(false);

        await act(async () => {
          vi.advanceTimersByTime(LARGE_MARKDOWN_THROTTLE_MS * 4);
          await Promise.resolve();
        });
        expect(commits[commits.length - 1]).toBe('fresh reply');
      });
    });

    it('keeps the anti-rewind guard when the same id is re-delivered shorter, and continues when longer', async () => {
      await withFakeTimers(async () => {
        const { commits, setMessages } = setup();
        const before = commits.length;

        await act(async () => {
          setMessages([{ id: 'a', role: 'assistant', content: [{ type: 'text', text: base.slice(0, 1000) }] }]);
          vi.advanceTimersByTime(LARGE_MARKDOWN_THROTTLE_MS * 4);
          await Promise.resolve();
        });
        expect(commits.slice(before).some(content => content.length < base.length)).toBe(false);
        expect(commits[commits.length - 1]).toBe(base);

        const longer = `${base}\ncontinued`;
        await act(async () => {
          setMessages([{ id: 'a', role: 'assistant', content: [{ type: 'text', text: longer }] }]);
          vi.advanceTimersByTime(LARGE_MARKDOWN_THROTTLE_MS * 4);
          await Promise.resolve();
        });
        expect(commits[commits.length - 1]).toBe(longer);
      });
    });
  });

  it('downloads an artifact through the turn that produced the message', async () => {
    const downloadSandboxFile = vi.fn(async () => new Blob(['hello harness']));
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    try {
      render(
        <ArtifactHarness
          content={['Files ready:', '', '```sandbox_artifacts', '[report.txt](/tmp/report.txt)', '```'].join('\n')}
          downloadSandboxFile={downloadSandboxFile}
        />,
      );

      fireEvent.click(await screen.findByText('report.txt'));

      await waitFor(() => {
        expect(downloadSandboxFile).toHaveBeenCalledWith({ turnId: 'turn-42', path: '/tmp/report.txt' });
      });
    } finally {
      anchorClick.mockRestore();
    }
  });

  it('shows a reopened reply whose file block the model indented as a file card, and downloads it', async () => {
    const downloadSandboxFile = vi.fn(async () => new Blob(['%PDF']));
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const content = [
      'Your weekly budget chart is ready.',
      '',
      '    ```sandbox_artifacts',
      '    [Weekly food budget chart](/egress/weekly_food_budget.pdf)',
      '    ```',
    ].join('\n');

    try {
      render(<ArtifactHarness content={content} downloadSandboxFile={downloadSandboxFile} />);

      fireEvent.click(await screen.findByRole('link', { name: 'Download Weekly food budget chart' }));

      await waitFor(() => {
        expect(downloadSandboxFile).toHaveBeenCalledWith({ turnId: 'turn-42', path: '/egress/weekly_food_budget.pdf' });
      });
      expect(document.body).not.toHaveTextContent('sandbox_artifacts');
      expect(document.body).not.toHaveTextContent('/egress/');
    } finally {
      anchorClick.mockRestore();
    }
  });

  it('says in plain words that a file could not be downloaded, never a bare status code', async () => {
    const failure = Object.assign(new Error('Request failed'), {
      statusCode: 412,
      body: {
        error: { message: 'This file was in a temporary workspace that has been cleared. Ask Aman to make it again.' },
      },
    });
    const downloadSandboxFile = vi.fn(async () => Promise.reject(failure));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ToasterProvider>
        <ArtifactHarness
          content={['```sandbox_artifacts', '[report.txt](/tmp/report.txt)', '```'].join('\n')}
          downloadSandboxFile={downloadSandboxFile}
        />
      </ToasterProvider>,
    );

    fireEvent.click(await screen.findByText('report.txt'));

    expect(await screen.findByText('The file could not be downloaded')).toBeInTheDocument();
    expect(
      screen.getByText('This file was in a temporary workspace that has been cleared. Ask Aman to make it again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Request failed/)).not.toBeInTheDocument();
  });
});

/** One finished assistant reply from turn `turn-42`, with the runtime extras a download needs. */
function ArtifactHarness({
  content,
  downloadSandboxFile,
}: {
  content: string;
  downloadSandboxFile: (request: { turnId: string; path: string }) => Promise<Blob>;
}) {
  const runtime = useExternalStoreRuntime({
    messages: [
      {
        role: 'assistant',
        content,
        metadata: { custom: { turnId: 'turn-42', sandboxId: 'sbx-1' } },
      } satisfies ThreadMessageLike,
    ],
    isRunning: false,
    convertMessage: (m: ThreadMessageLike) => m,
    onNew: async () => {},
    extras: trueFoundryExtras.provide({
      pendingApprovals: [],
      pendingToolResponses: [],
      pendingMcpAuth: null,
      resumeUnavailable: false,
      sandboxId: 'sbx-1',
      respondToToolApproval: () => {},
      respondToToolResponse: () => {},
      resumeMcpAuth: async () => {},
      downloadSandboxFile,
      cancel: async () => {},
      resetFromTurn: async () => {},
      reload: () => {},
      hasOlderHistory: false,
      isLoadingOlderHistory: false,
      loadOlderHistory: async () => {},
      draft: null,
    }),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
    </AssistantRuntimeProvider>
  );
}
