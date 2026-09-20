export function onSignalAbort(signal: AbortSignal | undefined, callback: () => void): void {
  if (!signal) {
    return;
  }
  if (signal.aborted) {
    callback();
    return;
  }
  signal.addEventListener('abort', callback, { once: true });
}

/** Read at an async cancellation boundary without TypeScript narrowing it across awaits. */
export function isSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function signalAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error('Operation aborted', { cause: reason });
  error.name = 'AbortError';
  return error;
}

export function throwIfSignalAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signalAbortError(signal);
  }
}

/**
 * Stops awaiting a provider or processor boundary as soon as its owning turn is
 * cancelled. The operation still receives the same signal so implementations
 * with native cancellation can stop their underlying work as well.
 */
export function awaitWithAbort<T>(input: { operation: Promise<T>; signal: AbortSignal | undefined }): Promise<T> {
  const signal = input.signal;
  if (signal === undefined) {
    return input.operation;
  }
  if (signal.aborted) {
    return Promise.reject(signalAbortError(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const settleFromAbort = () => {
      reject(signalAbortError(signal));
    };
    signal.addEventListener('abort', settleFromAbort, { once: true });
    input.operation.then(
      value => {
        signal.removeEventListener('abort', settleFromAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', settleFromAbort);
        reject(error instanceof Error ? error : new Error('Operation failed', { cause: error }));
      },
    );
  });
}
