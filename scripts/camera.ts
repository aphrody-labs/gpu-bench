// Prints the WGSL `VP` constant used by wgsl/cubes.wgsl so every implementation draws the exact same camera.
// WebGPU clip space: z in [0, 1], right-handed view space. Column-major output, as mat4x4f expects.
type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

export function viewProjection(eye: V3, target: V3, fovYDegrees: number, aspect: number, near: number, far: number): number[] {
  const f = norm(sub(target, eye));
  const s = norm(cross(f, [0, 1, 0]));
  const u = cross(s, f);
  const view = [s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0, -dot(s, eye), -dot(u, eye), dot(f, eye), 1];
  const t = 1 / Math.tan((fovYDegrees * Math.PI) / 360);
  const proj = [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (far * near) / (near - far), 0];
  const out: number[] = [];
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += proj[k * 4 + r]! * view[c * 4 + k]!;
    out.push(sum);
  }
  return out;
}

if (import.meta.main) {
  const m = viewProjection([150, 120, 420], [150, 150, 15], 50, 1920 / 1080, 0.1, 2000);
  const col = (c: number) => `vec4f(${m.slice(c * 4, c * 4 + 4).map((x) => x.toPrecision(9)).join(", ")})`;
  console.log(`const VP = mat4x4f(\n  ${[0, 1, 2, 3].map(col).join(",\n  ")}\n);`);
}
