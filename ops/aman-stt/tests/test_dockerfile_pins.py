import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# aman_stt refuses to import without a usable shared secret.
os.environ.setdefault("SPEECH_SECRET", "test-secret-value-with-more-than-32-chars")

from aman_stt import PINNED_MODELS  # noqa: E402

DOCKERFILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Dockerfile")


class DockerfilePinsTest(unittest.TestCase):
    """The image bakes in the pinned Whisper files; the build's checksums must match the service's pins."""

    def test_every_pinned_file_is_baked_in_with_its_hash(self):
        with open(DOCKERFILE, encoding="utf-8") as handle:
            text = handle.read()
        for size in ("small",):
            pinned = PINNED_MODELS[size]
            for name, digest in pinned.files.items():
                url = f"https://huggingface.co/{pinned.repo}/resolve/{pinned.revision}/{name}"
                self.assertIn(f"--checksum=sha256:{digest} {url} ", text, name)
                self.assertIn(f"/snapshots/{pinned.revision}/{name}", text, name)


if __name__ == "__main__":
    unittest.main()
