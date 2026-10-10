#!/usr/bin/env python3
"""
Downscales the turn-status panda sprite originals to WebP files small enough
to inline as data URIs in the trueforge-ui bundle.

Reads the six ~1600px source WebPs (which carry an XMP provenance tag) and
writes 128px-max WebPs, each under 15 KB, preserving the XMP tag, to
packages/trueforge-ui/src/assets/turn-status/.

Usage:
    python3 scripts/build-sprites.py --source <dir-with-originals>

The source originals live on the feat/turn-status-sprites branch under
packages/frontend/src/assets/turn-status/ and are intentionally not committed
here; only the downscaled outputs ship.
"""

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required: pip install Pillow")

SPRITES = [
    "listening",
    "remembering",
    "found-memories",
    "doing",
    "writing",
    "still-writing",
]

MAX_DIM = 128
MAX_BYTES = 15 * 1024
PROVENANCE_MARKER = b"trainedAlgorithmicMedia"


def downscale(source_path: Path, dest_path: Path) -> int:
    """Resize to fit within MAX_DIM, keep XMP, and return the output size."""
    with Image.open(source_path) as im:
        xmp = im.info.get("xmp")
        if not xmp:
            sys.exit(f"{source_path}: missing XMP provenance tag, refusing to build")
        if PROVENANCE_MARKER not in (xmp if isinstance(xmp, bytes) else xmp.encode()):
            sys.exit(f"{source_path}: XMP tag lacks {PROVENANCE_MARKER.decode()}, refusing to build")

        im = im.convert("RGB")
        im.thumbnail((MAX_DIM, MAX_DIM), Image.LANCZOS)

        # Walk quality down until the file fits the size budget.
        quality = 85
        while quality >= 10:
            im.save(dest_path, "WEBP", quality=quality, xmp=xmp, method=6)
            size = dest_path.stat().st_size
            if size <= MAX_BYTES:
                return size
            quality -= 5
        sys.exit(f"{source_path}: cannot fit under {MAX_BYTES} bytes")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build downscaled turn-status sprites.")
    parser.add_argument(
        "--source",
        required=True,
        help=(
            "Directory with the six source .webp originals. "
            "The originals live on the feat/turn-status-sprites branch under "
            "packages/frontend/src/assets/turn-status/ and are not on main; "
            "check out that branch or copy the files locally first."
        ),
    )
    args = parser.parse_args()

    source_dir = Path(args.source)
    repo_root = Path(__file__).resolve().parent.parent
    dest_dir = repo_root / "packages" / "trueforge-ui" / "src" / "assets" / "turn-status"
    dest_dir.mkdir(parents=True, exist_ok=True)

    for name in SPRITES:
        source_path = source_dir / f"{name}.webp"
        if not source_path.exists():
            sys.exit(f"missing source: {source_path}")
        dest_path = dest_dir / f"{name}.webp"
        size = downscale(source_path, dest_path)
        print(f"{name}.webp: {size} bytes")


if __name__ == "__main__":
    main()
