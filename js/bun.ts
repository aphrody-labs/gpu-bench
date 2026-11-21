// Dawn from Bun: the `webgpu` npm package (Dawn's Node bindings, prebuilt). Usage: bun js/bun.ts [--backend d3d12|vulkan] [--only a,b]
import { join } from "node:path";
import { create, globals } from "webgpu";
import { runAll } from "./core.ts";

const argument = (name: string) => Bun.argv[Bun.argv.indexOf(`--${name}`) + 1];
const backend = Bun.argv.includes("--backend") ? argument("backend")! : "d3d12";
Object.assign(globalThis, globals);
const gpu = create([`backend=${backend}`, "disable-dawn-features=timestamp_quantization"]);
const only = Bun.argv.includes("--only") ? new Set(argument("only")!.split(",")) : undefined;
const version = (await Bun.file(join(import.meta.dir, "node_modules/webgpu/package.json")).json()).version as string;
const result = await runAll(
  { gpu, wgsl: (name) => Bun.file(join(import.meta.dir, "..", "wgsl", `${name}.wgsl`)).text(), labels: { host: "bun", engine: "dawn", runtime: `bun ${Bun.version}`, package: `webgpu@${version}`, requestedBackend: backend } },
  only,
);
console.log(JSON.stringify(result));
process.exit(0);
