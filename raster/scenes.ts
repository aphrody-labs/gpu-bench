// Deterministic scene generator: one text scene per workload, consumed by both rasterizer harnesses.
// Grammar (one command per line, tokens separated by spaces, paths absolute, colours straight 0..255):
//   scene W H [textmode cached|shape]      font ID FILE      img ID W H FILE (raw premultiplied RGBA8)
//   path ID <M x y | L x y | Q x1 y1 x y | C x1 y1 x2 y2 x y | Z ...>
//   clear r g b a      save      restore      clip PATH AA      xf a b c d e f      blend NAME
//   fill PATH nz|eo AA PAINT      rect x y w h AA PAINT
//   stroke PATH width butt|round|square miter|round|bevel MITERLIMIT (-|d N v... phase) AA PAINT
//   image ID x y w h nearest|bilinear|bicubic|mip ALPHA      blur PATH SIGMA r g b a (gap probe)
//   text FONT size x y r g b a | string
//   PAINT = solid r g b a | lin x0 y0 x1 y1 SPREAD N (pos r g b a)xN | rad cx cy r SPREAD N ...
//         | rad2 x0 y0 r0 x1 y1 r1 SPREAD N ... | con cx cy startDeg endDeg SPREAD N ...
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

export const WIDTH = 1920;
export const HEIGHT = 1080;
export const BLEND_MODES = [
  "clear", "src", "dst", "srcover", "dstover", "srcin", "dstin", "srcout", "dstout", "srcatop", "dstatop",
  "xor", "plus", "modulate", "screen", "overlay", "darken", "lighten", "colordodge", "colorburn", "hardlight",
  "softlight", "difference", "exclusion", "multiply", "hue", "saturation", "color", "luminosity",
] as const;

export interface SceneFile {
  readonly name: string;
  readonly group: string;
  readonly width: number;
  readonly height: number;
  /** Scenes drawn at both device pixel ratios unless the canvas size is intrinsic. */
  readonly dprs: readonly number[];
  readonly lines: string[];
}

export interface Assets {
  readonly dir: string;
  readonly fontPath: string;
  readonly images: Map<string, { width: number; height: number; file: string }>;
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const n = (value: number) => (Math.round(value * 1000) / 1000).toString();
type Rgba = readonly [number, number, number, number];
type Stop = readonly [number, number, number, number, number];

class Builder {
  readonly lines: string[] = [];
  private readonly pathIds = new Map<string, string>();
  constructor(readonly name: string, readonly group: string, readonly width = WIDTH, readonly height = HEIGHT, readonly headerSuffix = "") {}
  emit(line: string) { this.lines.push(line); }
  path(d: string): string {
    let id = this.pathIds.get(d);
    if (!id) {
      id = `p${this.pathIds.size}`;
      this.pathIds.set(d, id);
      this.lines.push(`path ${id} ${d}`);
    }
    return id;
  }
  /** Path definitions must precede use, so they are written into the header slot reserved below. */
  finish(dprs: readonly number[] = [1, 2]): SceneFile {
    const header = [`scene ${this.width} ${this.height}${this.headerSuffix}`];
    const defs = this.lines.filter((line) => /^(path|font|img) /.test(line));
    const ops = this.lines.filter((line) => !/^(path|font|img) /.test(line));
    return { name: this.name, group: this.group, width: this.width, height: this.height, dprs, lines: [...header, ...defs, ...ops] };
  }
}

const solid = ([r, g, b, a]: Rgba) => `solid ${r} ${g} ${b} ${a}`;
const stops = (list: readonly Stop[]) => `${list.length} ${list.map((s) => `${n(s[0])} ${s[1]} ${s[2]} ${s[3]} ${s[4]}`).join(" ")}`;

function randomColor(rand: () => number, minAlpha = 90, maxAlpha = 255): Rgba {
  return [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), minAlpha + Math.floor(rand() * (maxAlpha - minAlpha + 1))];
}

function randomStops(rand: () => number, count: number, alpha = false): Stop[] {
  const list: Stop[] = [];
  for (let index = 0; index < count; index++) {
    const position = count === 1 ? 0 : index / (count - 1);
    const color = randomColor(rand, alpha ? 60 : 255, 255);
    list.push([position, color[0], color[1], color[2], color[3]]);
  }
  return list;
}

/** Closed smooth blob: Catmull-Rom through jittered points, written as cubic Beziers. */
function blobPath(rand: () => number, cx: number, cy: number, radius: number, points: number, jitter: number): string {
  const pts: [number, number][] = [];
  for (let index = 0; index < points; index++) {
    const angle = (index / points) * Math.PI * 2;
    const r = radius * (1 - jitter + rand() * jitter * 2);
    pts.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }
  return catmullClosed(pts);
}

function catmullClosed(pts: [number, number][]): string {
  const count = pts.length;
  let d = `M ${n(pts[0]![0])} ${n(pts[0]![1])}`;
  for (let index = 0; index < count; index++) {
    const p0 = pts[(index - 1 + count) % count]!;
    const p1 = pts[index]!;
    const p2 = pts[(index + 1) % count]!;
    const p3 = pts[(index + 2) % count]!;
    d += ` C ${n(p1[0] + (p2[0] - p0[0]) / 6)} ${n(p1[1] + (p2[1] - p0[1]) / 6)} ${n(p2[0] - (p3[0] - p1[0]) / 6)} ${n(p2[1] - (p3[1] - p1[1]) / 6)} ${n(p2[0])} ${n(p2[1])}`;
  }
  return `${d} Z`;
}

function walkPath(rand: () => number, x: number, y: number, segments: number, step: number, quads: boolean): string {
  let d = `M ${n(x)} ${n(y)}`;
  let angle = rand() * Math.PI * 2;
  for (let index = 0; index < segments; index++) {
    angle += (rand() - 0.5) * 2.2;
    const x1 = x + Math.cos(angle + 0.6) * step * 0.6;
    const y1 = y + Math.sin(angle + 0.6) * step * 0.6;
    x += Math.cos(angle) * step;
    y += Math.sin(angle) * step;
    if (quads) d += ` Q ${n(x1)} ${n(y1)} ${n(x)} ${n(y)}`;
    else {
      const x2 = x - Math.cos(angle - 0.5) * step * 0.4;
      const y2 = y - Math.sin(angle - 0.5) * step * 0.4;
      d += ` C ${n(x1)} ${n(y1)} ${n(x2)} ${n(y2)} ${n(x)} ${n(y)}`;
    }
  }
  return d;
}

const rectPath = (x: number, y: number, w: number, h: number) => `M ${n(x)} ${n(y)} L ${n(x + w)} ${n(y)} L ${n(x + w)} ${n(y + h)} L ${n(x)} ${n(y + h)} Z`;
const KAPPA = 0.5522847498;
function roundRectPath(x: number, y: number, w: number, h: number, radius: number): string {
  const r = Math.min(radius, w / 2, h / 2);
  const k = r * KAPPA;
  return [
    `M ${n(x + r)} ${n(y)}`, `L ${n(x + w - r)} ${n(y)}`,
    `C ${n(x + w - r + k)} ${n(y)} ${n(x + w)} ${n(y + r - k)} ${n(x + w)} ${n(y + r)}`, `L ${n(x + w)} ${n(y + h - r)}`,
    `C ${n(x + w)} ${n(y + h - r + k)} ${n(x + w - r + k)} ${n(y + h)} ${n(x + w - r)} ${n(y + h)}`, `L ${n(x + r)} ${n(y + h)}`,
    `C ${n(x + r - k)} ${n(y + h)} ${n(x)} ${n(y + h - r + k)} ${n(x)} ${n(y + h - r)}`, `L ${n(x)} ${n(y + r)}`,
    `C ${n(x)} ${n(y + r - k)} ${n(x + r - k)} ${n(y)} ${n(x + r)} ${n(y)} Z`,
  ].join(" ");
}
const circlePath = (cx: number, cy: number, r: number) => roundRectPath(cx - r, cy - r, r * 2, r * 2, r);
function starPath(cx: number, cy: number, outer: number, inner: number, points: number, rotation: number): string {
  let d = "";
  for (let index = 0; index < points * 2; index++) {
    const angle = rotation + (index / (points * 2)) * Math.PI * 2;
    const r = index % 2 === 0 ? outer : inner;
    d += `${index === 0 ? "M" : " L"} ${n(cx + Math.cos(angle) * r)} ${n(cy + Math.sin(angle) * r)}`;
  }
  return `${d} Z`;
}

const SPREADS = ["pad", "repeat", "reflect"] as const;

function background(b: Builder, color: Rgba = [24, 26, 32, 255]) {
  b.emit(`clear ${color.join(" ")}`);
}

export function pathFill(): SceneFile {
  const rand = mulberry32(11);
  const b = new Builder("paths-fill", "paths");
  background(b, [245, 245, 247, 255]);
  for (let index = 0; index < 1400; index++) {
    const radius = 14 + rand() * 110;
    const d = blobPath(rand, rand() * WIDTH, rand() * HEIGHT, radius, 5 + Math.floor(rand() * 7), 0.45);
    b.emit(`fill ${b.path(d)} ${index % 5 === 0 ? "eo" : "nz"} 1 ${solid(randomColor(rand))}`);
  }
  return b.finish();
}

export function pathStroke(): SceneFile {
  const rand = mulberry32(12);
  const b = new Builder("paths-stroke", "paths");
  background(b, [245, 245, 247, 255]);
  const caps = ["butt", "round", "square"], joins = ["miter", "round", "bevel"];
  for (let index = 0; index < 1500; index++) {
    const d = walkPath(rand, rand() * WIDTH, rand() * HEIGHT, 4 + Math.floor(rand() * 5), 30 + rand() * 40, index % 4 === 0);
    b.emit(`stroke ${b.path(d)} ${n(1 + rand() * 13)} ${caps[index % 3]} ${joins[Math.floor(index / 3) % 3]} 4 - 1 ${solid(randomColor(rand, 120, 255))}`);
  }
  return b.finish();
}

export function hairlines(): SceneFile {
  const rand = mulberry32(13);
  const b = new Builder("paths-hairline", "paths");
  background(b, [16, 18, 22, 255]);
  for (let index = 0; index < 5000; index++) {
    const d = index % 2 === 0
      ? `M ${n(rand() * WIDTH)} ${n(rand() * HEIGHT)} L ${n(rand() * WIDTH)} ${n(rand() * HEIGHT)}`
      : walkPath(rand, rand() * WIDTH, rand() * HEIGHT, 3, 40 + rand() * 60, false);
    const width = [0, 0.5, 1][index % 3]!;
    b.emit(`stroke ${b.path(d)} ${width} butt miter 4 - 1 ${solid(randomColor(rand, 140, 255))}`);
  }
  return b.finish();
}

export function dashes(): SceneFile {
  const rand = mulberry32(14);
  const b = new Builder("paths-dash", "paths");
  background(b, [245, 245, 247, 255]);
  const patterns = ["d 2 4 4 0", "d 2 10 5 3", "d 4 12 3 2 3 0", "d 2 1 6 0", "d 2 20 8 5"];
  for (let index = 0; index < 900; index++) {
    const d = walkPath(rand, rand() * WIDTH, rand() * HEIGHT, 3 + Math.floor(rand() * 4), 40 + rand() * 80, index % 3 === 0);
    const cap = index % 2 === 0 ? "round" : "butt";
    b.emit(`stroke ${b.path(d)} ${n(1 + rand() * 5)} ${cap} round 4 ${patterns[index % patterns.length]} 1 ${solid(randomColor(rand, 150, 255))}`);
  }
  return b.finish();
}

function gradientScene(name: string, kind: "lin" | "rad" | "con", seed: number): SceneFile {
  const rand = mulberry32(seed);
  const b = new Builder(name, "gradients");
  background(b, [20, 20, 24, 255]);
  b.emit(`rect 0 0 ${WIDTH} ${HEIGHT} 1 ${paint(rand, kind, 0, 0, WIDTH, HEIGHT, true)}`);
  for (let index = 0; index < 420; index++) {
    const w = 60 + rand() * 340, h = 60 + rand() * 240;
    const x = rand() * (WIDTH - w), y = rand() * (HEIGHT - h);
    const spec = paint(rand, kind, x, y, w, h, false);
    if (index % 3 === 0) b.emit(`fill ${b.path(roundRectPath(x, y, w, h, 8 + rand() * 40))} nz 1 ${spec}`);
    else b.emit(`rect ${n(x)} ${n(y)} ${n(w)} ${n(h)} 1 ${spec}`);
  }
  return b.finish();
}

function paint(rand: () => number, kind: "lin" | "rad" | "con", x: number, y: number, w: number, h: number, full: boolean): string {
  const spread = SPREADS[full ? 0 : Math.floor(rand() * 3)]!;
  const list = randomStops(rand, 2 + Math.floor(rand() * 4), !full && rand() < 0.3);
  const cx = x + w * (0.25 + rand() * 0.5), cy = y + h * (0.25 + rand() * 0.5);
  if (kind === "lin") {
    const reach = spread === "pad" ? 1 : 0.35;
    const angle = rand() * Math.PI * 2;
    const length = Math.hypot(w, h) * 0.5 * reach;
    return `lin ${n(cx - Math.cos(angle) * length)} ${n(cy - Math.sin(angle) * length)} ${n(cx + Math.cos(angle) * length)} ${n(cy + Math.sin(angle) * length)} ${spread} ${stops(list)}`;
  }
  if (kind === "rad") {
    const radius = Math.hypot(w, h) * (spread === "pad" ? 0.5 : 0.2) * (0.6 + rand() * 0.6);
    if (rand() < 0.35) {
      const fx = cx + (rand() - 0.5) * radius * 0.6, fy = cy + (rand() - 0.5) * radius * 0.6;
      return `rad2 ${n(fx)} ${n(fy)} ${n(radius * 0.1)} ${n(cx)} ${n(cy)} ${n(radius)} ${spread} ${stops(list)}`;
    }
    return `rad ${n(cx)} ${n(cy)} ${n(radius)} ${spread} ${stops(list)}`;
  }
  const start = rand() < 0.5 ? 0 : Math.floor(rand() * 120);
  const end = rand() < 0.5 ? 360 : start + 90 + Math.floor(rand() * 200);
  return `con ${n(cx)} ${n(cy)} ${start} ${end} ${end - start >= 360 ? "pad" : spread} ${stops(list)}`;
}

export const gradients = () => [gradientScene("grad-linear", "lin", 21), gradientScene("grad-radial", "rad", 22), gradientScene("grad-conic", "con", 23)];

export function images(assets: Assets): SceneFile[] {
  const scenes: SceneFile[] = [];
  const small = assets.images.get("photo256")!, big = assets.images.get("photo2048")!;
  for (const filter of ["nearest", "bilinear", "bicubic", "mip"] as const) {
    const rand = mulberry32(31);
    const b = new Builder(`image-${filter}`, "images");
    background(b, [32, 32, 36, 255]);
    b.emit(`img small ${small.width} ${small.height} ${small.file}`);
    b.emit(`img big ${big.width} ${big.height} ${big.file}`);
    for (let index = 0; index < 160; index++) {
      const useBig = index % 4 === 0;
      const source = useBig ? big : small;
      const scale = useBig ? 0.12 + rand() * 0.25 : 0.4 + rand() * 2.6;
      const w = source.width * scale, h = source.height * scale;
      const angle = (rand() - 0.5) * 1.2;
      const cx = rand() * WIDTH, cy = rand() * HEIGHT;
      b.emit(`xf ${n(Math.cos(angle))} ${n(Math.sin(angle))} ${n(-Math.sin(angle))} ${n(Math.cos(angle))} ${n(cx)} ${n(cy)}`);
      b.emit(`image ${useBig ? "big" : "small"} ${n(-w / 2)} ${n(-h / 2)} ${n(w)} ${n(h)} ${filter} ${n(0.75 + rand() * 0.25)}`);
    }
    scenes.push(b.finish());
  }
  return scenes;
}

export function blends(): SceneFile[] {
  return BLEND_MODES.map((mode) => {
    const rand = mulberry32(41);
    const b = new Builder(`blend-${mode}`, "blend");
    b.emit("clear 255 255 255 255");
    b.emit(`rect 0 0 ${WIDTH} ${HEIGHT} 1 lin 0 0 ${WIDTH} ${HEIGHT} pad 3 0 230 120 40 255 0.5 40 160 220 255 1 250 210 60 255`);
    for (let index = 0; index < 50; index++) {
      b.emit(`fill ${b.path(circlePath(rand() * WIDTH, rand() * HEIGHT, 30 + rand() * 90))} nz 1 ${solid(randomColor(rand, 200, 255))}`);
    }
    b.emit(`blend ${mode}`);
    for (let index = 0; index < 40; index++) {
      const cx = rand() * WIDTH, cy = rand() * HEIGHT, r = 60 + rand() * 200;
      b.emit(`fill ${b.path(circlePath(cx, cy, r))} nz 1 rad ${n(cx)} ${n(cy)} ${n(r)} pad 3 0 255 90 60 220 0.6 60 200 120 150 1 40 80 230 90`);
    }
    return b.finish();
  });
}

export function clips(): SceneFile[] {
  const rect = new Builder("clip-rect", "clip");
  const randR = mulberry32(51);
  background(rect, [30, 30, 36, 255]);
  for (let index = 0; index < 300; index++) {
    const x = randR() * (WIDTH - 300), y = randR() * (HEIGHT - 200), w = 80 + randR() * 300, h = 60 + randR() * 200;
    const angle = index % 2 === 0 ? 0 : (randR() - 0.5) * 1.2;
    rect.emit("save");
    rect.emit(`xf ${n(Math.cos(angle))} ${n(Math.sin(angle))} ${n(-Math.sin(angle))} ${n(Math.cos(angle))} ${n(x)} ${n(y)}`);
    rect.emit(`clip ${rect.path(rectPath(0, 0, w, h))} 1`);
    rect.emit(`rect ${n(-60)} ${n(-60)} ${n(w + 120)} ${n(h + 120)} 1 ${paint(randR, "lin", 0, 0, w, h, false)}`);
    rect.emit("restore");
  }
  const shape = new Builder("clip-path", "clip");
  const randP = mulberry32(52);
  background(shape, [30, 30, 36, 255]);
  for (let index = 0; index < 160; index++) {
    const cx = randP() * WIDTH, cy = randP() * HEIGHT, r = 50 + randP() * 150;
    shape.emit("save");
    shape.emit(`clip ${shape.path(starPath(cx, cy, r, r * 0.45, 5 + (index % 5), randP() * 3))} 1`);
    shape.emit(`rect ${n(cx - r)} ${n(cy - r)} ${n(r * 2)} ${n(r * 2)} 1 ${paint(randP, index % 2 ? "rad" : "con", cx - r, cy - r, r * 2, r * 2, false)}`);
    shape.emit("restore");
  }
  const nested = new Builder("clip-nested", "clip");
  const randN = mulberry32(53);
  background(nested, [30, 30, 36, 255]);
  for (let index = 0; index < 100; index++) {
    const cx = randN() * WIDTH, cy = randN() * HEIGHT, r = 80 + randN() * 160;
    nested.emit("save");
    nested.emit(`clip ${nested.path(circlePath(cx, cy, r))} 1`);
    nested.emit("save");
    nested.emit(`clip ${nested.path(roundRectPath(cx - r * 0.8, cy - r * 0.6, r * 1.6, r * 1.2, 24))} 1`);
    nested.emit("save");
    nested.emit(`clip ${nested.path(starPath(cx, cy, r * 0.95, r * 0.5, 7, randN() * 3))} 1`);
    nested.emit(`rect ${n(cx - r)} ${n(cy - r)} ${n(r * 2)} ${n(r * 2)} 1 ${paint(randN, "lin", cx - r, cy - r, r * 2, r * 2, false)}`);
    nested.emit("restore");
    nested.emit("restore");
    nested.emit("restore");
  }
  return [rect.finish(), shape.finish(), nested.finish()];
}

const WORDS = ("the quick brown fox jumps over a lazy dog while pixels flow through every stage of the pipeline and glyphs settle onto the grid " +
  "rasterizers trade accuracy for speed each frame carries curves edges coverage and blends that must agree across implementations").split(" ");

export function texts(assets: Assets): SceneFile[] {
  const out: SceneFile[] = [];
  for (const mode of ["cached", "shape"] as const) {
    const rand = mulberry32(61);
    const b = new Builder(`text-${mode}`, "text", WIDTH, HEIGHT, mode === "shape" ? " textmode shape" : "");
    background(b, [19, 19, 20, 255]);
    b.emit(`font f ${relative(assets.dir, assets.fontPath).replaceAll("\\", "/")}`);
    const sentence = (chars: number) => {
      let text = "";
      while (text.length < chars) text += `${WORDS[Math.floor(rand() * WORDS.length)]} `;
      return text.trim();
    };
    const column = (x: number, blocks: readonly (readonly [number, number, number, number])[], color: string) => {
      let y = 16;
      for (const [size, lines, chars, step] of blocks) {
        for (let line = 0; line < lines && y + size < HEIGHT - 8; line++) {
          b.emit(`text f ${size} ${x} ${n(y + size)} ${color} | ${sentence(chars)}`);
          y += step;
        }
        y += 10;
      }
    };
    // Sizes 48/24/16/14/12 on the left, 32/20/13 on the right: 330 text lines per frame.
    column(24, [[48, 3, 18, 64], [24, 6, 38, 32], [16, 16, 62, 22], [14, 20, 72, 20], [12, 24, 82, 17]], "227 227 227 255");
    column(980, [[32, 3, 28, 42], [20, 8, 46, 28], [13, 60, 74, 15.4]], "168 199 250 255");
    out.push(b.finish());
  }
  return out;
}

interface Tokens { dark: Record<string, string>; shape: Record<string, number> }

function hex(value: string, alpha = 255): Rgba {
  const v = value.replace("#", "");
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16), alpha];
}

/** A full Material 3 (dark) screen from fw-m3 tokens: rail, top bar, list-detail, cards, chips, buttons, controls. */
export function m3Screen(tokens: Tokens, assets: Assets): SceneFile {
  const role = (name: string, alpha = 255) => solid(hex(tokens.dark[name] ?? (() => { throw new Error(`missing role ${name}`); })(), alpha));
  const b = new Builder("m3-screen", "ui");
  b.emit(`font f ${relative(assets.dir, assets.fontPath).replaceAll("\\", "/")}`);
  b.emit(`clear ${hex(tokens.dark.surface!).join(" ")}`);
  const rr = (x: number, y: number, w: number, h: number, radius: number, paintSpec: string) =>
    b.emit(`fill ${b.path(roundRectPath(x, y, w, h, radius))} nz 1 ${paintSpec}`);
  const text = (size: number, x: number, y: number, color: Rgba, value: string) => b.emit(`text f ${size} ${n(x)} ${n(y)} ${color.join(" ")} | ${value}`);
  const on = hex(tokens.dark.on_surface!), onVariant = hex(tokens.dark.on_surface_variant!);
  const small = tokens.shape.small_px!, large = tokens.shape.large_px!, extraLarge = tokens.shape.extra_large_px!;

  // Navigation rail (80px, collapsed width token).
  rr(0, 0, 80, HEIGHT, 0, role("surface_container"));
  const railItems = ["Home", "Search", "Files", "Library", "Settings"];
  railItems.forEach((label, index) => {
    const y = 96 + index * 80;
    if (index === 1) rr(12, y, 56, 32, 16, role("secondary_container"));
    b.emit(`fill ${b.path(circlePath(40, y + 16, 8))} nz 1 ${role(index === 1 ? "on_secondary_container" : "on_surface_variant")}`);
    text(12, 40 - label.length * 3.1, y + 52, index === 1 ? on : onVariant, label);
  });
  rr(12, 16, 56, 56, 16, role("primary_container"));
  b.emit(`fill ${b.path(`M 32 40 L 48 40 L 48 36 L 56 44 L 48 52 L 48 48 L 32 48 Z`)} nz 1 ${role("on_primary_container")}`);

  // Top app bar with a search field and actions.
  rr(112, 16, 820, 56, 28, role("surface_container_high"));
  b.emit(`fill ${b.path(circlePath(144, 44, 9))} eo 1 ${role("on_surface_variant")}`);
  text(16, 176, 50, onVariant, "Search the file namespace");
  for (let index = 0; index < 3; index++) {
    rr(1500 + index * 56, 20, 48, 48, 24, role("surface_container"));
    b.emit(`fill ${b.path(circlePath(1524 + index * 56, 44, 7))} nz 1 ${role("on_surface_variant")}`);
  }
  b.emit(`fill ${b.path(circlePath(1860, 44, 22))} nz 1 lin 1838 22 1882 66 pad 2 0 ${hex(tokens.dark.primary!).join(" ")} 1 ${hex(tokens.dark.tertiary!).join(" ")}`);

  // List pane: 12 items with avatars, headline, supporting text, trailing meta.
  rr(112, 96, 520, 960, extraLarge, role("surface_container_low"));
  text(24, 144, 144, on, "Recent");
  for (let index = 0; index < 12; index++) {
    const y = 168 + index * 74;
    if (index === 2) rr(128, y, 488, 66, large, role("secondary_container"));
    else if (index === 5) rr(128, y, 488, 66, large, role("on_surface", 20));
    const hue = hex(index % 3 === 0 ? tokens.dark.primary_container! : index % 3 === 1 ? tokens.dark.tertiary_container! : tokens.dark.secondary_container!);
    b.emit(`fill ${b.path(circlePath(172, y + 33, 22))} nz 1 ${solid(hue)}`);
    text(16, 212, y + 30, index === 2 ? hex(tokens.dark.on_secondary_container!) : on, `Namespace entry ${index + 1}`);
    text(14, 212, y + 52, onVariant, `Mounted at /proc/${1000 + index * 37} - ${index + 3} min ago`);
    text(12, 560, y + 38, onVariant, `${(index * 7) % 60 + 1} KB`);
  }

  // Detail pane: hero card with a gradient, headline, chips, paragraph, buttons.
  rr(664, 96, 1244, 960, extraLarge, role("surface_container"));
  rr(688, 120, 1196, 300, large, `lin 688 120 1884 420 pad 3 0 ${hex(tokens.dark.primary_container!).join(" ")} 0.55 ${hex(tokens.dark.tertiary_container!).join(" ")} 1 ${hex(tokens.dark.secondary_container!).join(" ")}`);
  const primary = hex(tokens.dark.primary!).slice(0, 3).join(" ");
  b.emit(`fill ${b.path(circlePath(1560, 270, 96))} nz 1 rad 1560 270 96 pad 2 0 ${primary} 255 1 ${primary} 0`);
  text(48, 720, 340, hex(tokens.dark.on_primary_container!), "Everything is a file");
  text(24, 720, 384, hex(tokens.dark.on_primary_container!, 220), "Code is a design material");
  ["Filled", "Tonal", "Outlined", "Elevated", "Assist", "Filter"].forEach((label, index) => {
    const x = 688 + index * 148;
    rr(x, 448, 132, 32, small, index === 1 ? role("secondary_container") : role("surface_container_high"));
    b.emit(`stroke ${b.path(roundRectPath(x, 448, 132, 32, small))} 1 butt miter 4 - 1 ${role("outline_variant")}`);
    text(14, x + 16, 470, index === 1 ? hex(tokens.dark.on_secondary_container!) : onVariant, label);
  });
  for (let line = 0; line < 9; line++) {
    text(16, 688, 528 + line * 26, line === 0 ? on : onVariant, `Material 3 Expressive line ${line + 1}: shape scale, spring motion and tonal surfaces drawn by the rasterizer.`);
  }
  // Buttons: filled, tonal, outlined, text.
  [["Install", "primary", "on_primary"], ["Details", "secondary_container", "on_secondary_container"]].forEach(([label, container, content], index) => {
    rr(688 + index * 168, 784, 152, 40, 20, role(container!));
    text(14, 688 + index * 168 + 38, 809, hex(tokens.dark[content!]!), label!);
  });
  rr(1024, 784, 152, 40, 20, "solid 0 0 0 0");
  b.emit(`stroke ${b.path(roundRectPath(1024, 784, 152, 40, 20))} 1 butt miter 4 - 1 ${role("outline")}`);
  text(14, 1050, 809, hex(tokens.dark.primary!), "Cancel");
  // Switches, slider, progress, sliders.
  for (let index = 0; index < 4; index++) {
    const y = 856 + index * 44, enabled = index % 2 === 0;
    rr(688, y, 52, 32, 16, enabled ? role("primary") : role("surface_container_highest"));
    if (!enabled) b.emit(`stroke ${b.path(roundRectPath(688, y, 52, 32, 16))} 2 butt miter 4 - 1 ${role("outline")}`);
    b.emit(`fill ${b.path(circlePath(enabled ? 724 : 704, y + 16, enabled ? 12 : 8))} nz 1 ${role(enabled ? "on_primary" : "outline")}`);
    text(16, 760, y + 22, on, `Mount option ${index + 1}`);
  }
  rr(1000, 872, 560, 4, 2, role("surface_container_highest"));
  rr(1000, 872, 340, 4, 2, role("primary"));
  b.emit(`fill ${b.path(circlePath(1340, 874, 10))} nz 1 ${role("primary")}`);
  rr(1000, 940, 560, 16, 8, role("surface_container_highest"));
  rr(1000, 940, 400, 16, 8, role("primary"));
  // Extended FAB and cards.
  rr(1660, 960, 220, 72, large, role("primary_container"));
  text(16, 1720, 1004, hex(tokens.dark.on_primary_container!), "Compose");
  for (let index = 0; index < 3; index++) {
    rr(1500 + index * 128, 560 + 0, 112, 160, large, index === 0 ? role("surface_container_high") : role("surface_container_highest"));
    b.emit(`fill ${b.path(circlePath(1556 + index * 128, 620, 28))} nz 1 ${role("primary", 200 - index * 40)}`);
    text(14, 1516 + index * 128, 690, on, `Card ${index + 1}`);
  }
  return b.finish();
}

export function sprite(
  config: { cell: { w: number; h: number }; sheet: { w: number; h: number }; crop: { w: number; h: number }; scaled: { w: number; h: number }; pad: { x: number; y: number };
            frames: { source: string; row: number; column: number; dx: number; dy: number; mirror: boolean }[]; sources: Map<string, { file: string }> },
  filter: "bilinear" | "bicubic" | "mip",
): SceneFile {
  const b = new Builder(filter === "bilinear" ? "sprite-sheet" : `sprite-sheet-${filter}`, "sprite", config.sheet.w, config.sheet.h);
  for (const [name, { file }] of config.sources) b.emit(`img ${name} ${config.crop.w} ${config.crop.h} ${file}`);
  b.emit("clear 0 0 0 0");
  for (const frame of config.frames) {
    const x = frame.column * config.cell.w, y = frame.row * config.cell.h;
    const left = x + config.pad.x + frame.dx, top = y + config.pad.y + frame.dy;
    b.emit("save");
    b.emit(`clip ${b.path(rectPath(x, y, config.cell.w, config.cell.h))} 1`);
    b.emit(frame.mirror ? `xf -1 0 0 1 ${n(2 * left + config.scaled.w)} 0` : "xf 1 0 0 1 0 0");
    b.emit(`image ${frame.source} ${n(left)} ${n(top)} ${config.scaled.w} ${config.scaled.h} ${filter} 1`);
    b.emit("restore");
  }
  return b.finish([1, 2]);
}

/** Gap probe: Skia-only features a CSS renderer needs (blur and box-shadow), tiny-skia has no blur. */
export function blurProbe(): SceneFile {
  const rand = mulberry32(71);
  const b = new Builder("gap-blur-shadow", "gap");
  background(b, [19, 19, 20, 255]);
  for (let index = 0; index < 60; index++) {
    const x = rand() * (WIDTH - 300), y = rand() * (HEIGHT - 200), w = 120 + rand() * 180, h = 80 + rand() * 100;
    b.emit(`blur ${b.path(roundRectPath(x + 4, y + 8, w, h, 16))} ${n(4 + rand() * 12)} 0 0 0 150`);
    b.emit(`fill ${b.path(roundRectPath(x, y, w, h, 16))} nz 1 solid 40 42 44 255`);
  }
  return b.finish();
}

export async function writeScene(dir: string, scene: SceneFile): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${scene.name}.scene`);
  await writeFile(file, `${scene.lines.join("\n")}\n`);
  return file;
}
