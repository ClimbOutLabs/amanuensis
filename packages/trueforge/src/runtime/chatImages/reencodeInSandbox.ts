import type { HarvestedFile, RunCodeCallOptions, RunCodeResult } from '@truefoundry/trueforge-core/core';
import { z } from 'zod';

import { ChatImageRefusalSchema, type ChatImageRefusal } from '../../schemas/chatImages';
import { sniffImageType, sniffOutputType, type ChatImageOutputType } from './imageSniff';
import {
  CHAT_IMAGE_LOCAL_MAX_BYTES,
  CHAT_IMAGE_MAX_CONCURRENT_REENCODES,
  CHAT_IMAGE_OUTPUT_MAX_BYTES,
  CHAT_IMAGE_OUTPUT_MAX_SIDE_PX,
  CHAT_IMAGE_REENCODE_TIMEOUT_SECONDS,
} from './limits';
import { buildReencodeScript, REENCODE_INPUT_NAME } from './reencodeScript';

/** The part of the shared run_code service the re-encoder uses. */
export interface ImageSandbox {
  readonly driverKind: string;
  runCode(rawInput: unknown, options?: RunCodeCallOptions): Promise<RunCodeResult>;
}

export interface ReencodedImage {
  bytes: Buffer;
  type: ChatImageOutputType;
  width: number;
  height: number;
}

export type ReencodeOutcome = { ok: true; image: ReencodedImage } | { ok: false; reason: ChatImageRefusal };

const SandboxVerdictSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    name: z.enum(['image.png', 'image.webp']),
    format: z.enum(['png', 'webp']),
    width: z.number().int().min(1).max(CHAT_IMAGE_OUTPUT_MAX_SIDE_PX),
    height: z.number().int().min(1).max(CHAT_IMAGE_OUTPUT_MAX_SIDE_PX),
    frames: z.number().int().min(1),
  }),
  z.object({
    ok: z.literal(false),
    reason: ChatImageRefusalSchema.extract(['unsupported_type', 'too_large', 'undecodable']),
  }),
]);

function lastJsonLine(stdout: string): unknown {
  const line = stdout.trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * Re-encodes images inside the gVisor slot sandbox. Only the slot driver qualifies: it runs runsc with
 * no network, so a decoder exploit can neither reach the host nor send anything out. Every other
 * driver (Docker, disabled) refuses with `sandbox_unavailable` rather than decoding elsewhere.
 */
export function createImageReencoder(deps: { resolveSandbox: () => ImageSandbox | null }) {
  let active = 0;
  const waiting: (() => void)[] = [];

  async function withSlot<T>(work: () => Promise<T>): Promise<T> {
    if (active >= CHAT_IMAGE_MAX_CONCURRENT_REENCODES) {
      await new Promise<void>(resolve => waiting.push(resolve));
    }
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  async function runInSandbox(input: { sandbox: ImageSandbox; bytes: Buffer }): Promise<ReencodeOutcome> {
    const expectedType = sniffImageType(input.bytes);
    if (expectedType === null) {
      return { ok: false, reason: 'unsupported_type' };
    }
    let harvested: HarvestedFile[] = [];
    const result = await input.sandbox.runCode(
      {
        language: 'python',
        code: buildReencodeScript({ expectedType, ingressDir: '/ingress', egressDir: '/egress' }),
        files_in: [],
        timeout_seconds: CHAT_IMAGE_REENCODE_TIMEOUT_SECONDS,
      },
      {
        signal: undefined,
        attachments: [{ name: REENCODE_INPUT_NAME, bytes: input.bytes }],
        onProgress: undefined,
        onHarvestedFiles: files => {
          harvested = files;
          return Promise.resolve();
        },
      },
    );
    if (result.status !== 'ok' || result.exit_code !== 0) {
      return { ok: false, reason: 'undecodable' };
    }
    const verdict = SandboxVerdictSchema.safeParse(lastJsonLine(result.stdout));
    if (!verdict.success) {
      return { ok: false, reason: 'undecodable' };
    }
    if (!verdict.data.ok) {
      return { ok: false, reason: verdict.data.reason };
    }
    const { name, format, width, height } = verdict.data;
    const file = harvested.find(candidate => candidate.name === name);
    if (file === undefined || file.bytes.byteLength === 0) {
      return { ok: false, reason: 'undecodable' };
    }
    if (file.bytes.byteLength > CHAT_IMAGE_OUTPUT_MAX_BYTES) {
      return { ok: false, reason: 'too_large' };
    }
    // The host never trusts the sandbox's word for the type it wrote.
    if (sniffOutputType(file.bytes) !== format) {
      return { ok: false, reason: 'undecodable' };
    }
    return { ok: true, image: { bytes: file.bytes, type: format, width, height } };
  }

  return async function reencodeImage(input: { bytes: Buffer }): Promise<ReencodeOutcome> {
    if (input.bytes.byteLength > CHAT_IMAGE_LOCAL_MAX_BYTES) {
      return { ok: false, reason: 'too_large' };
    }
    if (sniffImageType(input.bytes) === null) {
      return { ok: false, reason: 'unsupported_type' };
    }
    const sandbox = deps.resolveSandbox();
    if (sandbox?.driverKind !== 'slots') {
      return { ok: false, reason: 'sandbox_unavailable' };
    }
    return withSlot(() => runInSandbox({ sandbox, bytes: input.bytes }));
  };
}

export type ImageReencoder = ReturnType<typeof createImageReencoder>;
