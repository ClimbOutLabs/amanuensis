import { ChatImageScope, Markdown, SlotsProvider, TurnImages, type ChatImagesCatalog } from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

const SILENT_ID = 'a'.repeat(32);
const ARTIFACT_ID = 'b'.repeat(32);
const APPROVED_ID = 'c'.repeat(32);

/** Stands in for the server: answers like the real routes, and every image address is same-origin. */
const port: ChatImagesCatalog = {
  listTurnImages: () =>
    Promise.resolve({
      artifacts: [{ path: 'run_code/chart.png', name: 'chart.png' }],
      emails: [{ tool_call_id: 'mail-1', count: 3 }],
    }),
  showTurnImages: ({ source, approved }) => {
    if (source.kind === 'artifact') {
      return Promise.resolve({
        status: 'done',
        images: [{ status: 'shown', image_id: ARTIFACT_ID, width: 320, height: 200 }],
      });
    }
    if (source.kind === 'email') {
      return Promise.resolve(
        approved
          ? { status: 'done', images: [{ status: 'shown', image_id: APPROVED_ID, width: 320, height: 200 }] }
          : { status: 'ask', count: 3, host: null },
      );
    }
    if (source.kind === 'reply' && source.url === 'https://example.com/photos/harbor.png') {
      return Promise.resolve({
        status: 'done',
        images: [{ status: 'shown', image_id: SILENT_ID, width: 320, height: 200 }],
      });
    }
    if (source.kind === 'reply' && source.url === 'https://example.com/photos/huge.png') {
      return Promise.resolve({ status: 'done', images: [{ status: 'refused', reason: 'too_large' }] });
    }
    return Promise.resolve(
      approved
        ? { status: 'done', images: [{ status: 'shown', image_id: APPROVED_ID, width: 320, height: 200 }] }
        : { status: 'ask', count: 1, host: 'example.org' },
    );
  },
  imageUrl: ({ sessionId, imageId }) => `/api/chat-images/sessions/${sessionId}/images/${imageId}`,
};

const REPLY = [
  'Here is the harbor photo from the search:',
  '',
  '![Harbor at dusk](https://example.com/photos/harbor.png)',
  '',
  'And the chart someone linked:',
  '',
  '![Quarterly chart](https://example.org/charts/q3.png)',
  '',
  'The full-size scan is too big to show here: ![Scan](https://example.com/photos/huge.png)',
  '',
  'An inline picture I tried to draw: ![Sketch](data:image/png;base64,iVBORw0KGgo=)',
].join('\n');

const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('Missing fixture root');

createRoot(rootElement).render(
  <SlotsProvider>
    <main style={{ maxWidth: '48rem', margin: '0 auto', padding: '1rem' }}>
      <ChatImageScope port={port} sessionId="session-1" turnId="turn-1" settled>
        <Markdown content={REPLY} />
        <TurnImages />
      </ChatImageScope>
    </main>
  </SlotsProvider>,
);
