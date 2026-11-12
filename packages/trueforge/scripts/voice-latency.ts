/**
 * Measures voice-mode latency on this machine: from the end of the person's speech to the first
 * sound back. The speech model (Silero) and the voice (the text-to-speech service) are real. The
 * speech-to-text and the model's first sentence are stand-ins with a delay you choose, because
 * those depend on hardware and the hosted model that this script cannot see.
 *
 *   pnpm voice:latency -- --stt-ms 300 --model-ms 700 --runs 5
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import configuration from '../src/config';
import { measureTurnLatency } from '../src/voice/latencyHarness';
import { syntheticRecording } from '../src/voice/syntheticSpeech';
import type { SpeechToText, VoiceTurnRunner } from '../src/voice/transport';
import { SidecarSpeechSynthesizer } from '../src/voice/ttsClient';
import { SileroSpeechProbability } from '../src/voice/vad/sileroVad';
import { downloadVadModel } from './lib/vadModelDownload';

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '5' },
    'stt-ms': { type: 'string', default: '300' },
    'model-ms': { type: 'string', default: '700' },
  },
});

const runs = Number(values.runs);
const sttMs = Number(values['stt-ms']);
const modelMs = Number(values['model-ms']);
if (![runs, sttMs, modelMs].every(Number.isFinite)) {
  throw new Error('Give --runs, --stt-ms and --model-ms as numbers.');
}

const wait = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

const stt: SpeechToText = {
  transcribe: async () => {
    await wait(sttMs);
    return 'what is on my calendar today';
  },
};

const turns: VoiceTurnRunner = {
  sendMessage: async ({ onText }) => {
    await wait(modelMs);
    onText('You have two meetings today. ');
    onText('The first is at ten.');
    return { kind: 'done', turnId: 'latency-run', approvals: [] };
  },
  answerApproval: () => Promise.resolve({ kind: 'failed' }),
  stillWaiting: () => Promise.resolve(true),
  cancel: () => Promise.resolve(),
};

// One utterance of 1.4 s, then enough quiet for the speech model to decide it has ended.
const recording = syntheticRecording([
  { kind: 'quiet', seconds: 0.4 },
  { kind: 'speech', seconds: 1.4 },
  { kind: 'quiet', seconds: 1.6 },
]);

const model = await readFile(await downloadVadModel({ dir: configuration.VOICE_VAD_MODEL_DIR }));
const tts = new SidecarSpeechSynthesizer();

const totals: number[] = [];
for (let run = 1; run <= runs; run += 1) {
  const vad = await SileroSpeechProbability.load({ model });
  const latency = await measureTurnLatency({ parts: { vad, stt, tts, turns }, recording });
  totals.push(latency.total_ms);
  console.log(`run ${String(run)}:`, JSON.stringify(latency));
}
const sorted = [...totals].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
console.log(
  `median ${String(median)} ms, best ${String(sorted[0])} ms, worst ${String(sorted[sorted.length - 1])} ms ` +
    `(stand-ins: speech to text ${String(sttMs)} ms, model first sentence ${String(modelMs)} ms; target under 2000 ms)`,
);
