import * as esbuild from "esbuild";

async function main() {
  const result = await esbuild.build({
    stdin: { contents: `export async function test() { const m = await import("../proto.js"); return m; }`, loader: "ts" },
    bundle: false,
    format: "cjs",
    write: false,
  });
  console.log(result.outputFiles[0].text);
}

main();
