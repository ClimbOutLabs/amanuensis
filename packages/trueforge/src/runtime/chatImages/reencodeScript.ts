import type { ChatImageInputType } from '@truefoundry/trueforge-core/core/chatImages';
import {
  CHAT_IMAGE_LOCAL_MAX_BYTES,
  CHAT_IMAGE_MAX_FRAME_PIXELS,
  CHAT_IMAGE_MAX_FRAMES,
  CHAT_IMAGE_MAX_SIDE_PX,
  CHAT_IMAGE_MAX_TOTAL_PIXELS,
  CHAT_IMAGE_OUTPUT_MAX_SIDE_PX,
} from './limits';

/** File name the input is staged under in /ingress. */
export const REENCODE_INPUT_NAME = 'chat-image-input';

/** Pillow format names for each allow-listed input type. */
const PILLOW_FORMAT: Record<ChatImageInputType, string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  gif: 'GIF',
  webp: 'WEBP',
};

/**
 * Python run inside the network-free sandbox. Pillow opens the file with only the allow-listed
 * plugins, must agree with the host's sniffed type, and checks size, pixel and frame caps before any
 * pixel data is decoded. Each frame is rebuilt from raw pixels into a fresh image, so no EXIF, ICC,
 * text chunk or trailing payload can survive, then written as PNG (one frame) or WebP (animated).
 * The last stdout line is a JSON verdict the host parses.
 */
export function buildReencodeScript(input: {
  expectedType: ChatImageInputType;
  ingressDir: string;
  egressDir: string;
}): string {
  const config = JSON.stringify({
    input_path: `${input.ingressDir}/${REENCODE_INPUT_NAME}`,
    egress_dir: input.egressDir,
    expected_format: PILLOW_FORMAT[input.expectedType],
    allowed_formats: Object.values(PILLOW_FORMAT),
    max_bytes: CHAT_IMAGE_LOCAL_MAX_BYTES,
    max_frame_pixels: CHAT_IMAGE_MAX_FRAME_PIXELS,
    max_side: CHAT_IMAGE_MAX_SIDE_PX,
    max_frames: CHAT_IMAGE_MAX_FRAMES,
    max_total_pixels: CHAT_IMAGE_MAX_TOTAL_PIXELS,
    output_max_side: CHAT_IMAGE_OUTPUT_MAX_SIDE_PX,
  });
  return `import io, json, os, sys, warnings
CONFIG = json.loads(${JSON.stringify(config)})

def verdict(payload):
    print(json.dumps(payload))
    sys.exit(0)

def refuse(reason):
    verdict({"ok": False, "reason": reason})

try:
    from PIL import Image, ImageOps
except Exception:
    refuse("undecodable")

# Pillow's own bomb guard stays on as a second line; the explicit checks below run first.
Image.MAX_IMAGE_PIXELS = CONFIG["max_frame_pixels"]
warnings.simplefilter("error", Image.DecompressionBombWarning)

try:
    if os.path.getsize(CONFIG["input_path"]) > CONFIG["max_bytes"]:
        refuse("too_large")
    with open(CONFIG["input_path"], "rb") as handle:
        data = handle.read()
except Exception:
    refuse("undecodable")

try:
    source = Image.open(io.BytesIO(data), formats=CONFIG["allowed_formats"])
except (Image.DecompressionBombError, Image.DecompressionBombWarning):
    refuse("too_large")
except Exception:
    refuse("unsupported_type")

if source.format != CONFIG["expected_format"]:
    refuse("unsupported_type")

width, height = source.size
if width < 1 or height < 1:
    refuse("undecodable")
if width > CONFIG["max_side"] or height > CONFIG["max_side"] or width * height > CONFIG["max_frame_pixels"]:
    refuse("too_large")
frame_count = getattr(source, "n_frames", 1)
if frame_count < 1 or frame_count > CONFIG["max_frames"]:
    refuse("too_large")
if width * height * frame_count > CONFIG["max_total_pixels"]:
    refuse("too_large")

def has_alpha(image):
    return image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info)

def clean_frame(image):
    mode = "RGBA" if has_alpha(image) else "RGB"
    converted = image.convert(mode)
    # A fresh image from raw pixels carries no metadata of the source.
    fresh = Image.frombytes(mode, converted.size, converted.tobytes())
    fresh.thumbnail((CONFIG["output_max_side"], CONFIG["output_max_side"]))
    return fresh

frames = []
durations = []
try:
    if frame_count == 1:
        source.load()
        # Honour the camera orientation before the tag is dropped.
        frames.append(clean_frame(ImageOps.exif_transpose(source)))
    else:
        for index in range(frame_count):
            source.seek(index)
            source.load()
            durations.append(int(source.info.get("duration", 100)) or 100)
            frames.append(clean_frame(source))
except (Image.DecompressionBombError, Image.DecompressionBombWarning):
    refuse("too_large")
except Exception:
    refuse("undecodable")

if any(frame.mode != frames[0].mode or frame.size != frames[0].size for frame in frames):
    frames = [frame.convert("RGBA").resize(frames[0].size) for frame in frames]

try:
    if len(frames) == 1:
        name = "image.png"
        frames[0].save(os.path.join(CONFIG["egress_dir"], name), format="PNG", optimize=True)
        output_format = "png"
    else:
        name = "image.webp"
        frames[0].save(
            os.path.join(CONFIG["egress_dir"], name),
            format="WEBP",
            save_all=True,
            append_images=frames[1:],
            duration=durations,
            loop=0,
            quality=85,
        )
        output_format = "webp"
except Exception:
    refuse("undecodable")

verdict({
    "ok": True,
    "name": name,
    "format": output_format,
    "width": frames[0].size[0],
    "height": frames[0].size[1],
    "frames": len(frames),
})
`;
}
