import { AgentInternalsDisclosure, SlotsProvider } from '@truefoundry/trueforge-ui';
import '@truefoundry/trueforge-ui/styles.css';
import { createRoot } from 'react-dom/client';

const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('Missing fixture root');

createRoot(rootElement).render(
  <SlotsProvider theme={{ webFonts: false }}>
    <main style={{ maxWidth: '48rem', margin: '0 auto', padding: '1rem' }}>
      <AgentInternalsDisclosure summary="Details" expanded={false} dataTestPrefix="answer">
        <p data-testid="answer-usage">Nemotron 3 Super · Token Factory · 2,140 tokens (1,800 in, 340 out)</p>
      </AgentInternalsDisclosure>
    </main>
  </SlotsProvider>,
);
