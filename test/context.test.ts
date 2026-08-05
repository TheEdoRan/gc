import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildPrompt, discoverContext, MAX_PROMPT_BYTES } from "../src/context.ts";

test("discovers nearest instructions and deduplicates symlinks", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "gc-context-"));
	await mkdir(path.join(root, "src", "deep"), { recursive: true });
	await writeFile(path.join(root, "AGENTS.md"), "root rules");
	await symlink("AGENTS.md", path.join(root, "CLAUDE.md"));
	await writeFile(path.join(root, "CONTEXT.md"), "project facts");
	await writeFile(path.join(root, "src", "AGENTS.md"), "src rules");
	const context = await discoverContext(root, ["src/deep/file.ts"]);
	assert.deepEqual(
		context.instructions.map((document) => document.path),
		["src/AGENTS.md", "AGENTS.md"]
	);
	assert.equal(context.context[0]?.content, "project facts");
	const prompt = buildPrompt({
		diff: "diff",
		files: ["src/deep/file.ts"],
		history: ["fix: old"],
		context,
		split: true,
		instructions: "do this",
	});
	assert.ok(prompt.indexOf("do this") < prompt.indexOf("src rules"));
	assert.ok(prompt.indexOf("src rules") < prompt.indexOf("root rules"));
});

test("rejects oversized prompts", () => {
	assert.throws(
		() =>
			buildPrompt({
				diff: "x".repeat(MAX_PROMPT_BYTES),
				files: ["a"],
				history: [],
				context: { root: "/repo", instructions: [], context: [] },
				split: false,
			}),
		/Prompt exceeds/
	);
});
