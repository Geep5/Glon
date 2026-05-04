import { createRequire } from "node:module";

async function main() {
  const code = `
    async function test() {
      try {
        const m = await import("../proto.js");
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    return test();
  `;
  
  const factory = new Function(code);
  const result = await factory();
  console.log("new Function import():", result);
}

main();
