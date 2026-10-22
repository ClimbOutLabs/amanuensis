import { HOLD_SAY, searchHoldCardText } from '../../../src/core/permissions/searchHoldText';

describe('searchHoldCardText', () => {
  it('closes a plain query with one period', () => {
    expect(searchHoldCardText({ summary: 'lamp', say: HOLD_SAY.generic })).toBe(
      `Web search: lamp. ${HOLD_SAY.generic}`,
    );
  });

  it('still closes a query that ends in a period, so the query keeps its own', () => {
    expect(searchHoldCardText({ summary: 'St. Mary Inc.', say: HOLD_SAY.generic })).toBe(
      `Web search: St. Mary Inc.. ${HOLD_SAY.generic}`,
    );
  });

  it('adds no period after a question', () => {
    expect(searchHoldCardText({ summary: 'open now?', say: HOLD_SAY.generic })).toBe(
      `Web search: open now? ${HOLD_SAY.generic}`,
    );
  });

  it('names the search alone when the query is empty', () => {
    expect(searchHoldCardText({ summary: '', say: HOLD_SAY.generic })).toBe(`Web search. ${HOLD_SAY.generic}`);
  });
});
