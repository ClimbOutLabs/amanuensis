import { SlotsProvider, UserMessageBubble } from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('Missing fixture root');

// The read-only transcript has no thread shell, so the bubble must get its measure from the stylesheet alone.
createRoot(rootElement).render(
  <SlotsProvider theme={{ webFonts: false }}>
    <div className="aui-root" data-testid="transcript" style={{ width: '75rem', padding: '1rem' }}>
      <UserMessageBubble text={'A long message that keeps going. '.repeat(20)} />
    </div>
  </SlotsProvider>,
);
