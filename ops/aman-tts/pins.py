"""Pinned voice assets for aman-tts, shared by the image build and the service.

Every file the image fetches is listed here with its exact URL, size and
SHA-256. The build refuses any download that does not match, and the service
re-checks the model file before it loads. Stdlib only, so the build stage
needs nothing but Python.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PinnedAsset:
    name: str
    url: str
    size: int
    sha256: str
    license: str


# Kokoro-82M v1.0 (hexgrad/Kokoro-82M, Apache-2.0), int8 ONNX export and voice
# style vectors as published on the kokoro-onnx model-files-v1.0 release.
# misaki 0.9.4 (Apache-2.0) is fetched only for its English word lists; none of
# its code, and none of its GPL or LGPL extras, goes into the image.
PINNED_ASSETS: tuple[PinnedAsset, ...] = (
    PinnedAsset(
        name="kokoro-v1.0.int8.onnx",
        url="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx",
        size=92361271,
        sha256="6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb",
        license="Apache-2.0",
    ),
    PinnedAsset(
        name="voices-v1.0.bin",
        url="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
        size=28214398,
        sha256="bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
        license="Apache-2.0",
    ),
    PinnedAsset(
        name="misaki-0.9.4-py3-none-any.whl",
        url="https://files.pythonhosted.org/packages/82/ec/0ee4110ddb54278b8f21c40a140370ae8f687036c4edf578316602697c56/misaki-0.9.4-py3-none-any.whl",
        size=3617774,
        sha256="90e2eeb169786c014c429e5058d2ea6bcd02d651f2a24450ba6c9ffc0f8da15a",
        license="Apache-2.0",
    ),
)

MODEL_ASSET = PINNED_ASSETS[0]

# American English voices baked into the image. The first is the default. The settings voice
# picker in trueforge-ui (`SERVER_VOICES`) offers these same ids.
VOICE_IDS: tuple[str, ...] = ("af_heart", "af_bella", "af_nicole", "af_sarah", "am_michael", "am_fenrir")

# Files the build writes into the asset directory.
MODEL_FILE = "model.onnx"
VOICES_FILE = "voices.npz"
LEXICON_FILES: tuple[str, ...] = ("us_gold.json", "us_silver.json")
