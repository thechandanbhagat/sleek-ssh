import { build } from "esbuild";

await build({
  entryPoints: ["src/automation.ts", "src/local-terminal-panel.ts", "src/command-palette.ts"],
  outdir: "src/generated",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  logLevel: "info",
});
