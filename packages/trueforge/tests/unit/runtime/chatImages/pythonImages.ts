import { spawnSync } from 'node:child_process';

/** True when the host has python3 with Pillow, which the sandbox guest image also ships. */
export function hostHasPillow(): boolean {
  const probe = spawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8' });
  return probe.status === 0;
}

/** Runs Python that writes image bytes to `out` (a BytesIO) and returns them; fixtures are invented here. */
export function pythonImage(body: string): Buffer {
  const script = `import base64, io, struct, sys, zlib\nfrom PIL import Image, PngImagePlugin\nout = io.BytesIO()\n${body}\nsys.stdout.write(base64.b64encode(out.getvalue()).decode())\n`;
  const run = spawnSync('python3', ['-c', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) {
    throw new Error(`fixture script failed: ${run.stderr}`);
  }
  return Buffer.from(run.stdout, 'base64');
}

export const PNG_WITH_TEXT = `info = PngImagePlugin.PngInfo()
info.add_text("Comment", "invented-secret-comment")
Image.new("RGB", (40, 30), (200, 10, 10)).save(out, "PNG", pnginfo=info)`;

export const JPEG_WITH_EXIF = `img = Image.new("RGB", (64, 48), (10, 120, 200))
exif = Image.Exif()
exif[0x010F] = "InventedCameraMaker"
exif[0x0112] = 6
img.save(out, "JPEG", exif=exif.tobytes())`;

export const ANIMATED_GIF = `frames = [Image.new("RGB", (20, 20), (i * 80, 40, 200 - i * 60)) for i in range(3)]
frames[0].save(out, "GIF", save_all=True, append_images=frames[1:], duration=120, loop=0)`;

export const GIF_101_FRAMES = `frames = [Image.new("RGB", (4, 4), (i, 255 - i, (i * 7) % 256)) for i in range(101)]
frames[0].save(out, "GIF", save_all=True, append_images=frames[1:], duration=50, loop=0, optimize=False, disposal=2)`;

/** A tiny PNG whose header claims 20000 x 20000 pixels: refused before any pixel data is read. */
export const PNG_HUGE_HEADER = `def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
ihdr = struct.pack(">IIBBBBB", 20000, 20000, 8, 2, 0, 0, 0)
out.write(b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\\x00" * 64)) + chunk(b"IEND", b""))`;

/** A valid PNG with an HTML payload appended after IEND. */
export const PNG_HTML_POLYGLOT = `Image.new("RGB", (8, 8), (0, 0, 0)).save(out, "PNG")
out.write(b"<html><script>alert('invented')</script></html>")`;

export const SVG_IMAGE = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://example.com/pixel.png"/></svg>',
);
