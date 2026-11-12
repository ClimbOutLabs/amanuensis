/**
 * A report request the renderer cannot draw as given, such as a field over its length cap. Its message tells the
 * model what to change, so the report tools return it; any other report failure is logged and replaced by a fixed
 * sentence.
 */
export class ReportInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReportInputError';
  }
}
