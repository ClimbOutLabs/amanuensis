/** A refusal or failure the caller can show as is; `status` is the HTTP status the route answers with. */
export class DataImportError extends Error {
  readonly status: 400 | 409 | 500 | 503;

  constructor(message: string, status: 400 | 409 | 500 | 503, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DataImportError';
    this.status = status;
  }
}
