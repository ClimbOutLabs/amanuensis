import { InMemoryApprovalTokenStore } from '@truefoundry/trueforge-core/core';
import { runApprovalTokenStoreContractSuite } from '../../db/approvalTokenStoreContractSuite';

describe('InMemoryApprovalTokenStore (ApprovalTokenStore contract)', () => {
  let store: InMemoryApprovalTokenStore;

  beforeEach(() => {
    store = new InMemoryApprovalTokenStore();
  });

  runApprovalTokenStoreContractSuite(() => ({
    store: () => store,
    peer: () => store,
    countRows: () => Promise.resolve(store.size),
  }));
});
