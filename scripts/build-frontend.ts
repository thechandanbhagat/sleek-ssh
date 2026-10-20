import { build } from "esbuild";

await build({
  entryPoints: ["src/automation.ts"],
  outfile: "src/generated/automation.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  logLevel: "info",
});
