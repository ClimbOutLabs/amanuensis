import { REDACTED, redactSecretShapes } from '../../../src/dataExport/secretScrub';

describe('redactSecretShapes for things people type into a chat', () => {
  it('hides a card number written in groups of four', () => {
    expect(redactSecretShapes('Card 4111 1111 1111 1111, expires 2027')).toBe(`Card ${REDACTED}, expires 2027`);
    expect(redactSecretShapes('4111-1111-1111-1111')).toBe(REDACTED);
  });

  it('leaves plain digit runs such as timestamps and ids alone', () => {
    expect(redactSecretShapes('Sent at 1761734400000 to order 123456789012')).toBe(
      'Sent at 1761734400000 to order 123456789012',
    );
  });

  it('hides a password or PIN stated in prose and keeps the word', () => {
    expect(redactSecretShapes('The wifi password is Tr0ub4dor&3 for guests')).toBe(
      `The wifi password is ${REDACTED} for guests`,
    );
    expect(redactSecretShapes('PIN: 4921')).toBe(`PIN: ${REDACTED}`);
  });
});
