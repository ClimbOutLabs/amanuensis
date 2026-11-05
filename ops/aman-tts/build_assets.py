"""Fetches and verifies the pinned voice assets at image build time.

Usage: python build_assets.py <output dir>

Downloads every file in pins.PINNED_ASSETS, refuses any whose size or SHA-256
differs from the pin, then writes the model, the baked voices and the English
word lists into the output directory. Nothing is fetched at runtime.
"""

from __future__ import annotations

import hashlib
import io
import os
import sys
import time
import urllib.request
import zipfile

from pins import (
    LEXICON_FILES,
    MODEL_ASSET,
    MODEL_FILE,
    PINNED_ASSETS,
    VOICE_IDS,
    VOICES_FILE,
    PinnedAsset,
)

ATTEMPTS = 4


class AssetVerificationError(Exception):
    """A downloaded asset did not match its pin."""


def verify_bytes(asset: PinnedAsset, data: bytes) -> None:
    if len(data) != asset.size:
        raise AssetVerificationError(f"{asset.name}: expected {asset.size} bytes, got {len(data)}")
    actual = hashlib.sha256(data).hexdigest()
    if actual != asset.sha256:
        raise AssetVerificationError(f"{asset.name}: SHA-256 mismatch, expected {asset.sha256[:16]}..., got {actual[:16]}...")


def download(asset: PinnedAsset) -> bytes:
    last_error: Exception | None = None
    for attempt in range(1, ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(asset.url, timeout=120) as response:
                data = response.read()
            verify_bytes(asset, data)
            return data
        except AssetVerificationError:
            raise
        except OSError as exc:
            last_error = exc
            print(f"download of {asset.name} failed (attempt {attempt}): {exc}", file=sys.stderr)
            time.sleep(2**attempt)
    raise AssetVerificationError(f"{asset.name}: download failed after {ATTEMPTS} attempts") from last_error


def select_voices(voices_npz: bytes, voice_ids: tuple[str, ...]) -> bytes:
    """Copy only the baked voices out of the full voice archive (an .npz zip)."""
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(voices_npz)) as source, zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as target:
        names = set(source.namelist())
        for voice_id in voice_ids:
            member = f"{voice_id}.npy"
            if member not in names:
                raise AssetVerificationError(f"voice {voice_id} is not in {MODEL_ASSET.name}'s voice archive")
            target.writestr(member, source.read(member))
    return out.getvalue()


def extract_lexicon(wheel: bytes, output_dir: str) -> None:
    """Copy misaki's English word lists and its license out of the wheel."""
    with zipfile.ZipFile(io.BytesIO(wheel)) as source:
        for name in LEXICON_FILES:
            with open(os.path.join(output_dir, name), "wb") as fh:
                fh.write(source.read(f"misaki/data/{name}"))
        with open(os.path.join(output_dir, "LICENSE.misaki"), "wb") as fh:
            fh.write(source.read("misaki-0.9.4.dist-info/licenses/LICENSE"))


def main(output_dir: str) -> None:
    os.makedirs(output_dir, exist_ok=True)
    fetched = {asset.name: download(asset) for asset in PINNED_ASSETS}
    with open(os.path.join(output_dir, MODEL_FILE), "wb") as fh:
        fh.write(fetched["kokoro-v1.0.int8.onnx"])
    with open(os.path.join(output_dir, VOICES_FILE), "wb") as fh:
        fh.write(select_voices(fetched["voices-v1.0.bin"], VOICE_IDS))
    extract_lexicon(fetched["misaki-0.9.4-py3-none-any.whl"], output_dir)
    print(f"assets verified and written to {output_dir}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python build_assets.py <output dir>")
    main(sys.argv[1])
