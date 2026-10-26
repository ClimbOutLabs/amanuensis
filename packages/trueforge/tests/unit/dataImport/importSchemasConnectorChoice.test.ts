import { connectorOffKey } from '@truefoundry/trueforge-core/core/connectors/chatConnectorChoice';
import { ImportSessionRecordSchema } from '../../../src/dataImport/importSchemas';

/** A chat as an archive written before the off choice became one flag per connector holds it. */
const OLDER_METADATA = { connectors_off: '["Email"]', agent_details: 'expanded' };

describe('importing a chat that stored its off choice as one name list', () => {
  it('keeps the choice as flags, so the connector stays off', () => {
    const parsed = ImportSessionRecordSchema.shape.metadata.parse(structuredClone(OLDER_METADATA));
    expect(parsed).toEqual({ [connectorOffKey('Email')]: '1', agent_details: 'expanded' });
  });
});
