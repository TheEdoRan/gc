import { defineConfig } from "tsdown";

export default defineConfig({
	entry: "src/index.ts",
	format: "esm",
	platform: "node",
	target: "node22.13",
	outDir: "dist",
	clean: true,
	dts: false,
	sourcemap: true,
	outputOptions: {
		entryFileNames: "index.mjs",
	},
});
