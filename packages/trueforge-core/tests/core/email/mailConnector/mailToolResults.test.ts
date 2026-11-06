import { failedIdsOfResult } from '../../../../src/core/email/mailConnector/mailToolResults';

describe('failedIdsOfResult', () => {
  it('reads the ids the connector could not fetch, from the structured result or its JSON text', () => {
    const body = { emails: [], requested_count: 2, retrieved_count: 0, failed_ids: ['7', 8] };
    expect(failedIdsOfResult({ structuredContent: body })).toEqual(['7', '8']);
    expect(failedIdsOfResult({ content: [{ type: 'text', text: JSON.stringify(body) }] })).toEqual(['7', '8']);
  });

  it('reads nothing when the result lists none or has another shape', () => {
    expect(failedIdsOfResult({ structuredContent: { emails: [] } })).toEqual([]);
    expect(failedIdsOfResult('nope')).toEqual([]);
    expect(failedIdsOfResult(undefined)).toEqual([]);
  });
});
