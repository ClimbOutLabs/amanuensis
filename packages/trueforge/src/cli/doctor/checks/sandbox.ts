import { offCheck, type Check } from '../schemas';

const REASON =
  'run_code is not available: no sandbox isolation driver is configured for this deployment. The sandbox arrives in a later release.';

export function checkRunCode(): Check {
  return offCheck({ id: 'run_code', detail: REASON });
}

export function checkAttachments(): Check {
  return offCheck({
    id: 'attachments',
    detail:
      'Reading email attachments is not available: it needs the same sandbox as run_code, which arrives in a later release.',
  });
}
