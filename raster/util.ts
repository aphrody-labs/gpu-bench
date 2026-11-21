// Shared helpers: statistics (perf-math method), PNG codec, frame fidelity metrics, process helpers.
import { deflateSync, inflateSync } from "node:zlib";

export interface Stats {
  readonly runs: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly mean: number;
  /** Median absolute deviation: the spread to compare a difference against. */
  readonly mad: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return NaN;
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}

export function stats(values: readonly number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const deviations = sorted.map((v) => Math.abs(v - p50)).sort((a, b) => a - b);
  return {
    runs: sorted.length,
    min: sorted[0] ?? NaN,
    p50,
    p95: percentile(sorted, 0.95),
    mean: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
    mad: percentile(deviations, 0.5),
  };
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface Image {
  width: number;
  height: number;
  /** Row-major 8-bit RGBA. */
  data: Uint8Array;
}

export function encodePng({ width, height, data }: Image): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 3 })), chunk("IEND", new Uint8Array(0))];
  return Buffer.concat(parts);
}

/** Decodes a non-interlaced 8-bit RGB/RGBA PNG (the output of Bun.Image.png()). */
export function decodePng(png: Uint8Array): Image {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0, height = 0, channels = 0;
  const idat: Uint8Array[] = [];
  for (let offset = 8; offset + 12 <= png.length; ) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 0;
      if (body[8] !== 8 || channels === 0 || body[12] !== 0) throw new Error("decodePng: only 8-bit RGB/RGBA non-interlaced");
    } else if (type === "IDAT") idat.push(body);
    offset += 12 + length;
  }
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const source = y * (stride + 1) + 1, row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[row + x - channels]! : 0;
      const up = y > 0 ? pixels[row - stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[row - stride + x - channels]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const dl = Math.abs(estimate - left), du = Math.abs(estimate - up), dul = Math.abs(estimate - upLeft);
        predictor = dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
      }
      pixels[row + x] = (raw[source + x]! + predictor) & 255;
    }
  }
  if (channels === 4) return { width, height, data: pixels };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) rgba.set([pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, 255], j);
  return { width, height, data: rgba };
}

export interface Fidelity {
  /** PSNR in dB over all four channels; Infinity when the frames are identical. */
  psnr: number;
  maxDelta: number;
  meanAbs: number;
  /** Share of pixels whose largest channel delta exceeds 2 / 16 (levels of 255). */
  over2: number;
  over16: number;
  worst: { x: number; y: number };
}

/** Compares two premultiplied RGBA8 frames; `reference` is the Skia frame. */
export function fidelity(reference: Uint8Array, other: Uint8Array, width: number): Fidelity {
  if (reference.length !== other.length) throw new Error(`frame size mismatch ${reference.length} vs ${other.length}`);
  let squared = 0, sum = 0, maxDelta = 0, over2 = 0, over16 = 0, worstAt = 0;
  for (let pixel = 0; pixel < reference.length; pixel += 4) {
    let pixelMax = 0;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(reference[pixel + channel]! - other[pixel + channel]!);
      squared += delta * delta;
      sum += delta;
      if (delta > pixelMax) pixelMax = delta;
    }
    if (pixelMax > 2) over2++;
    if (pixelMax > 16) over16++;
    if (pixelMax > maxDelta) {
      maxDelta = pixelMax;
      worstAt = pixel / 4;
    }
  }
  const pixels = reference.length / 4;
  const mse = squared / reference.length;
  return {
    psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse),
    maxDelta,
    meanAbs: sum / reference.length,
    over2: over2 / pixels,
    over16: over16 / pixels,
    worst: { x: worstAt % width, y: Math.floor(worstAt / width) },
  };
}

/** Absolute difference, amplified, as an opaque image (black = identical). */
export function diffImage(reference: Uint8Array, other: Uint8Array, width: number, height: number, gain = 8): Image {
  const data = new Uint8Array(reference.length);
  for (let pixel = 0; pixel < reference.length; pixel += 4) {
    let max = 0;
    for (let channel = 0; channel < 4; channel++) max = Math.max(max, Math.abs(reference[pixel + channel]! - other[pixel + channel]!));
    const level = Math.min(255, max * gain);
    data[pixel] = level;
    data[pixel + 1] = level;
    data[pixel + 2] = level;
    data[pixel + 3] = 255;
  }
  return { width, height, data };
}

/** Premultiplied frame composited over a checkerboard-free mid grey, for viewing. */
export function viewable(frame: Uint8Array, width: number, height: number): Image {
  const data = new Uint8Array(frame.length);
  for (let pixel = 0; pixel < frame.length; pixel += 4) {
    const alpha = frame[pixel + 3]!;
    for (let channel = 0; channel < 3; channel++) data[pixel + channel] = Math.min(255, frame[pixel + channel]! + Math.round(((255 - alpha) * 128) / 255));
    data[pixel + 3] = 255;
  }
  return { width, height, data };
}

export function crop(image: Image, x: number, y: number, size: number, zoom: number): Image {
  const x0 = Math.max(0, Math.min(image.width - size, x - size / 2));
  const y0 = Math.max(0, Math.min(image.height - size, y - size / 2));
  const out = new Uint8Array(size * zoom * size * zoom * 4);
  for (let oy = 0; oy < size * zoom; oy++) {
    for (let ox = 0; ox < size * zoom; ox++) {
      const source = ((y0 + Math.floor(oy / zoom)) * image.width + x0 + Math.floor(ox / zoom)) * 4;
      out.set(image.data.subarray(source, source + 4), (oy * size * zoom + ox) * 4);
    }
  }
  return { width: size * zoom, height: size * zoom, data: out };
}

/** Lays equally sized images side by side with a 4px gap. */
export function sideBySide(images: readonly Image[]): Image {
  const gap = 4, height = images[0]!.height;
  const width = images.reduce((sum, image) => sum + image.width, 0) + gap * (images.length - 1);
  const data = new Uint8Array(width * height * 4).fill(255);
  let left = 0;
  for (const image of images) {
    for (let y = 0; y < height; y++) data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), (y * width + left) * 4);
    left += image.width + gap;
  }
  return { width, height: height, data };
}

export async function run(command: string[], options: { cwd?: string; env?: Record<string, string>; quiet?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string; seconds: number }> {
  const started = performance.now();
  const child = Bun.spawn(command, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (!options.quiet && code !== 0) process.stderr.write(`$ ${command.join(" ")}\n${stderr.slice(-2000)}\n`);
  return { code, stdout, stderr, seconds: (performance.now() - started) / 1000 };
}
