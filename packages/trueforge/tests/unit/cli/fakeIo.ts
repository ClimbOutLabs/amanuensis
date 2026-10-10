import type { CliIo } from '../../../src/cli/io';

export interface FakeIo extends CliIo {
  out: string[];
  err: string[];
}

export function fakeIo({ stdin = '' }: { stdin?: string } = {}): FakeIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    readStdin: () => Promise.resolve(stdin),
    stdout: text => {
      out.push(text);
      return Promise.resolve();
    },
    stderr: text => {
      err.push(text);
      return Promise.resolve();
    },
  };
}
