import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { AssistantMessageContainer, ThemeProvider } from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'done';
const mode = params.get('mode') === 'dark' ? 'dark' : 'light';

const runCode = {
  type: 'tool-call' as const,
  toolCallId: 'tool-run',
  toolName: 'run_code',
  args: { language: 'python', code: 'print(4 * 5)' },
  argsText: '{"language":"python","code":"print(4 * 5)"}',
};
const result = { ok: true, stdout: '20\n' };
const approval = {
  interrupt: { type: 'human' as const, payload: {} },
  approval: {
    id: 'approval-1',
    options: [
      { id: 'allow-once', kind: 'allow-once' as const },
      { id: 'deny', kind: 'reject-once' as const },
    ],
  },
};
const pre = { type: 'text' as const, text: "I'll run that calculation for you." };

const scenes: Record<'done' | 'streaming' | 'approval', { messages: ThreadMessageLike[]; isRunning: boolean }> = {
  done: {
    isRunning: false,
    messages: [
      { role: 'user', content: 'What is 4 times 5? Run it.' },
      { role: 'assistant', content: [pre, { ...runCode, result }, { type: 'text', text: 'The result is **20**.' }] },
    ],
  },
  streaming: {
    isRunning: true,
    messages: [
      { role: 'user', content: 'What is 4 times 5? Run it.' },
      {
        role: 'assistant',
        status: { type: 'running' },
        content: [pre, { ...runCode, result }, { type: 'text', text: 'The result is **20**, because four fives' }],
      },
    ],
  },
  approval: {
    isRunning: false,
    messages: [
      { role: 'user', content: 'What is 4 times 5? Run it.' },
      {
        role: 'assistant',
        status: { type: 'requires-action', reason: 'tool-calls' },
        content: [pre, { ...runCode, ...approval }],
      },
    ],
  },
};

function Harness() {
  const current = scene === 'streaming' ? scenes.streaming : scene === 'approval' ? scenes.approval : scenes.done;
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: current.messages,
    isRunning: current.isRunning,
    convertMessage: message => message,
    onNew: async () => {},
  });
  return (
    <ThemeProvider theme={{ mode }}>
      <AssistantRuntimeProvider runtime={runtime}>
        <div
          style={{
            maxWidth: '48rem',
            margin: '0 auto',
            padding: '1.5rem',
            background: 'var(--background, transparent)',
          }}
        >
          <ThreadPrimitive.Messages>
            {({ message }) =>
              message.role === 'user' ? (
                <div style={{ textAlign: 'right', margin: '0.5rem 0' }}>
                  {message.content.map(p => (p.type === 'text' ? p.text : '')).join('')}
                </div>
              ) : (
                <AssistantMessageContainer />
              )
            }
          </ThreadPrimitive.Messages>
        </div>
      </AssistantRuntimeProvider>
    </ThemeProvider>
  );
}

const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('Missing root');
createRoot(rootElement).render(<Harness />);
