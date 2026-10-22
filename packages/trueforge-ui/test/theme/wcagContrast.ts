/** Parses the color forms preset tokens use (hex, rgb(), oklch(), transparent) and computes WCAG contrast. */

export type Rgba = { r: number; g: number; b: number; a: number };

const HEX = /^#([0-9a-f]{3,8})$/i;
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+)(%?)\s*)?\)$/i;
const OKLCH = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?)\s*)?\)$/i;

function encodeSrgb(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function decodeSrgb(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function oklchToSrgb(l: number, c: number, hueDegrees: number): Omit<Rgba, 'a'> {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = c * Math.cos(hue);
  const b = c * Math.sin(hue);
  const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: encodeSrgb(4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp),
    g: encodeSrgb(-1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp),
    b: encodeSrgb(-0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp),
  };
}

function alphaOf(value: string, percent: string | undefined): number {
  if (value === undefined || value === '') return 1;
  const parsed = Number(value);
  return percent === '%' ? parsed / 100 : parsed;
}

/** Throws on a form it does not understand, so an unchecked token cannot pass silently. */
export function parseColor(input: string): Rgba {
  const value = input.trim();
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const hex = HEX.exec(value);
  if (hex) {
    const digits = hex[1] ?? '';
    const full =
      digits.length === 3 || digits.length === 4
        ? digits
            .split('')
            .map(d => d + d)
            .join('')
        : digits;
    if (full.length !== 6 && full.length !== 8) throw new Error(`Unsupported hex color: ${input}`);
    const channel = (offset: number) => parseInt(full.slice(offset, offset + 2), 16) / 255;
    return { r: channel(0), g: channel(2), b: channel(4), a: full.length === 8 ? channel(6) : 1 };
  }

  const rgb = RGB.exec(value);
  if (rgb) {
    return {
      r: Number(rgb[1]) / 255,
      g: Number(rgb[2]) / 255,
      b: Number(rgb[3]) / 255,
      a: rgb[4] === undefined ? 1 : alphaOf(rgb[4], rgb[5]),
    };
  }

  const oklch = OKLCH.exec(value);
  if (oklch) {
    const l = oklch[2] === '%' ? Number(oklch[1]) / 100 : Number(oklch[1]);
    return { ...oklchToSrgb(l, Number(oklch[3]), Number(oklch[4])), a: alphaOf(oklch[5] ?? '', oklch[6]) };
  }

  throw new Error(`Unsupported color form: ${input}`);
}

/** Blends a translucent color over an opaque surface, in sRGB, the way browsers paint it. */
export function compositeOver(foreground: Rgba, background: Rgba): Rgba {
  const mix = (f: number, b: number) => f * foreground.a + b * (1 - foreground.a);
  return {
    r: mix(foreground.r, background.r),
    g: mix(foreground.g, background.g),
    b: mix(foreground.b, background.b),
    a: 1,
  };
}

function relativeLuminance(color: Rgba): number {
  return 0.2126 * decodeSrgb(color.r) + 0.7152 * decodeSrgb(color.g) + 0.0722 * decodeSrgb(color.b);
}

/** WCAG 2 contrast ratio. A translucent text or background is composited over `base`. */
export function contrastRatio({ text, surface, base }: { text: string; surface: string; base: string }): number {
  const opaqueBase = parseColor(base);
  const backdrop = compositeOver(parseColor(surface), opaqueBase);
  const ink = compositeOver(parseColor(text), backdrop);
  const lighter = Math.max(relativeLuminance(ink), relativeLuminance(backdrop));
  const darker = Math.min(relativeLuminance(ink), relativeLuminance(backdrop));
  return (lighter + 0.05) / (darker + 0.05);
}
