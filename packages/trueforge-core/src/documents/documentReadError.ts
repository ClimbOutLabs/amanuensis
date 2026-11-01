/**
 * A failure to read a document whose message is a fixed, plain sentence written for the person. Only this kind of
 * error has its message shown; any other failure is logged and replaced by a fixed sentence, because raw errors
 * can carry sandbox paths, provider details or text quoted from the file.
 */
export class DocumentReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DocumentReadError';
  }
}
