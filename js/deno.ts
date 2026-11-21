// wgpu from Deno (deno_webgpu is built on wgpu). Usage: deno run -A --unstable-webgpu js/deno.ts [--backend dx12|vulkan] [--only a,b]
import { runAll } from "./core.ts";

const argument = (name: string) => Deno.args[Deno.args.indexOf(`--${name}`) + 1];
const backend = Deno.args.includes("--backend") ? argument("backend")! : "dx12";
const only = Deno.args.includes("--only") ? new Set(argument("only")!.split(",")) : undefined;
const root = new URL("../wgsl/", import.meta.url);
const result = await runAll(
  { gpu: navigator.gpu, wgsl: (name) => Deno.readTextFile(new URL(`${name}.wgsl`, root)), labels: { host: "deno", engine: "wgpu", runtime: `deno ${Deno.version.deno} (v8 ${Deno.version.v8})`, requestedBackend: backend } },
  only,
);
console.log(JSON.stringify(result));
Deno.exit(0);
