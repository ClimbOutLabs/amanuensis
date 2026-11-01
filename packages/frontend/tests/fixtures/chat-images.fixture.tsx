import { ChatImageScope, Markdown, SlotsProvider, TurnImages, type ChatImagesCatalog } from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

const HARBOR_ID = 'a'.repeat(32);
const ARTIFACT_ID = 'b'.repeat(32);
const APPROVED_ID = 'c'.repeat(32);
/** The image route answers this id with a 404, as a copy the browser cannot load would. */
const BROKEN_ID = 'd'.repeat(32);

/** Stands in for the server: answers like the real routes, and every image address is same-origin. */
const port: ChatImagesCatalog = {
  listTurnImages: () =>
    Promise.resolve({
      artifacts: [{ path: 'run_code/chart.png', name: 'chart.png' }],
      tool_images: [],
      emails: [{ tool_call_id: 'mail-1', count: 2 }],
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
          ? {
              status: 'done',
              images: [
                { status: 'shown', image_id: APPROVED_ID, width: 320, height: 200 },
                { status: 'shown', image_id: APPROVED_ID, width: 320, height: 200 },
              ],
            }
          : { status: 'ask', count: 2, host: null },
      );
    }
    if (source.kind === 'reply') {
      if (!approved) {
        return Promise.resolve({ status: 'ask', count: 1, host: 'example.com' });
      }
      if (source.url === 'https://example.com/photos/harbor.png') {
        return Promise.resolve({
          status: 'done',
          images: [{ status: 'shown', image_id: HARBOR_ID, width: 320, height: 200 }],
        });
      }
      if (source.url === 'https://example.com/photos/broken.png') {
        return Promise.resolve({
          status: 'done',
          images: [{ status: 'shown', image_id: BROKEN_ID, width: 320, height: 200 }],
        });
      }
      return Promise.resolve({ status: 'done', images: [{ status: 'refused', reason: 'too_large' }] });
    }
    return Promise.reject(new Error(`unexpected source ${source.kind}`));
  },
  imageUrl: ({ sessionId, imageId }) => `/api/chat-images/sessions/${sessionId}/images/${imageId}`,
};

const REPLY = [
  'Here is the harbor photo from the search:',
  '',
  '![Harbor at dusk](https://example.com/photos/harbor.png)',
  '',
  'And a second photo, which will not load:',
  '',
  '![Broken photo](https://example.com/photos/broken.png)',
  '',
  'The full-size scan is too big to show here: ![Scan](https://example.com/photos/huge.png)',
  '',
  'An inline picture I tried to draw: ![Sketch](data:image/png;base64,iVBORw0KGgo=)',
].join('\n');

const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('Missing fixture root');

createRoot(rootElement).render(
  // As in the app: the shell CSP keeps stylesheets and fonts on the app origin.
  <SlotsProvider theme={{ webFonts: false }}>
    <main style={{ maxWidth: '48rem', margin: '0 auto', padding: '1rem' }}>
      <ChatImageScope port={port} sessionId="session-1" turnId="turn-1" settled>
        <Markdown content={REPLY} />
        <TurnImages />
      </ChatImageScope>
    </main>
  </SlotsProvider>,
);
