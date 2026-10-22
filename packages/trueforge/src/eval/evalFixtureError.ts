/** Thrown for a call the eval fixtures cannot answer. The message is safe to show in a reply. */
export class EvalFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalFixtureError';
  }
}
