// Browser host: Chrome (Dawn) or Firefox (wgpu) runs this bundle; the result is POSTed to the harness server.
import { runAll } from "./core.ts";

const base = location.origin;
const status = document.getElementById("status")!;
const label = (name: string) => new URLSearchParams(location.search).get(name) ?? "";

async function main() {
  const only = label("only") ? new Set(label("only").split(",")) : undefined;
  status.textContent = "running";
  const result = await runAll(
    {
      gpu: navigator.gpu,
      wgsl: async (name) => (await fetch(`${base}/wgsl/${name}.wgsl`)).text(),
      labels: { host: label("browser"), engine: label("engine"), runtime: navigator.userAgent, crossOriginIsolated: String(crossOriginIsolated), requestedBackend: label("backend") || "default" },
    },
    only,
  );
  await fetch(`${base}/result`, { method: "POST", body: JSON.stringify(result) });
  status.textContent = "done";
}

main().catch(async (error) => {
  status.textContent = `failed: ${error}`;
  await fetch(`${base}/result`, { method: "POST", body: JSON.stringify({ failed: String(error?.stack ?? error) }) });
});
