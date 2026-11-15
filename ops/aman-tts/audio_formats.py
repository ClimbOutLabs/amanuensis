"""Output encodings for aman-tts: WAV, raw 16-bit PCM and 8 kHz mu-law (G.711).

Kokoro makes 24 kHz audio. Telephone audio is 8 kHz mu-law, so the mu-law path
low-pass filters and drops to a third of the rate. The converter keeps its filter
state between pieces, so a reply streamed sentence by sentence has no seams.
numpy only: nothing here pulls in a GPL or LGPL package.
"""

from __future__ import annotations

import io
import wave
from dataclasses import dataclass

import numpy as np

SOURCE_RATE = 24000
PHONE_RATE = 8000
DECIMATION = SOURCE_RATE // PHONE_RATE
# Telephone audio carries up to about 3.4 kHz; the filter passes that and blocks what would alias.
LOW_PASS_HZ = 3600.0
FILTER_TAPS = 63

_MULAW_BIAS = 0x84
_MULAW_CLIP = 32635


@dataclass(frozen=True)
class AudioFormat:
    name: str
    content_type: str
    sample_rate: int


WAV = AudioFormat("wav", "audio/wav", SOURCE_RATE)
PCM16 = AudioFormat("pcm16", "audio/L16", SOURCE_RATE)
MULAW8K = AudioFormat("mulaw8k", "audio/basic", PHONE_RATE)
FORMATS: dict[str, AudioFormat] = {fmt.name: fmt for fmt in (WAV, PCM16, MULAW8K)}
# Formats that are a bare run of samples with no header, so they can be sent in pieces.
STREAMABLE = ("pcm16", "mulaw8k")


def to_pcm16(audio: np.ndarray) -> np.ndarray:
    return (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")


def encode_wav(audio: np.ndarray) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SOURCE_RATE)
        wav.writeframes(to_pcm16(audio).tobytes())
    return buf.getvalue()


def mulaw_encode(pcm: np.ndarray) -> bytes:
    """G.711 mu-law for 16-bit samples."""
    samples = pcm.astype(np.int32)
    sign = np.where(samples < 0, 0x80, 0)
    magnitude = np.minimum(np.abs(samples), _MULAW_CLIP) + _MULAW_BIAS
    exponent = np.clip(np.floor(np.log2(magnitude)).astype(np.int32) - 7, 0, 7)
    mantissa = (magnitude >> (exponent + 3)) & 0x0F
    return ((~(sign | (exponent << 4) | mantissa)) & 0xFF).astype(np.uint8).tobytes()


def _low_pass_kernel() -> np.ndarray:
    n = np.arange(FILTER_TAPS) - (FILTER_TAPS - 1) / 2
    cutoff = LOW_PASS_HZ / SOURCE_RATE
    kernel = 2 * cutoff * np.sinc(2 * cutoff * n) * np.hamming(FILTER_TAPS)
    return (kernel / kernel.sum()).astype(np.float32)


class Encoder:
    """Turns pieces of 24 kHz float audio into bytes of one output format, in order."""

    def __init__(self, fmt: AudioFormat) -> None:
        self.format = fmt
        self._kernel = _low_pass_kernel()
        self._history = np.zeros(FILTER_TAPS - 1, dtype=np.float32)
        # Position of the next kept sample, so decimation stays in phase across pieces.
        self._phase = 0

    def feed(self, audio: np.ndarray) -> bytes:
        if self.format.name == "pcm16":
            return to_pcm16(audio).tobytes()
        if self.format.name == "mulaw8k":
            return mulaw_encode(to_pcm16(self._to_phone_rate(audio)))
        raise ValueError(f"{self.format.name} cannot be sent in pieces")

    def _to_phone_rate(self, audio: np.ndarray) -> np.ndarray:
        padded = np.concatenate([self._history, audio.astype(np.float32)])
        filtered = np.convolve(padded, self._kernel, mode="valid")
        self._history = padded[-(FILTER_TAPS - 1) :]
        kept = filtered[self._phase :: DECIMATION]
        self._phase = (self._phase - len(filtered)) % DECIMATION
        return kept
