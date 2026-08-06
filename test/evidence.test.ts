import assert from "node:assert/strict";
import { test } from "node:test";

import { buildEvidence, buildFallbackPlan, buildGroups, type EvidenceOptions } from "../src/evidence.ts";
import type { StagedFile } from "../src/git.ts";

function staged(overrides: Partial<StagedFile> & Pick<StagedFile, "path">): StagedFile {
	const head = overrides.head ?? `diff --git a/${overrides.path} b/${overrides.path}\n+one\n-two\n`;
	return {
		status: "M",
		added: 1,
		deleted: 1,
		bytes: Buffer.byteLength(head),
		truncated: false,
		binary: false,
		...overrides,
		head,
	};
}

function evidence(files: StagedFile[], options: Partial<EvidenceOptions> = {}) {
	return buildEvidence(files, { byteBudget: 100_000, ...options });
}

test("sends binary files as stats only", () => {
	const result = evidence([staged({ path: "logo.png", binary: true, added: 0, deleted: 0, head: "" })]);
	assert.equal(result.tiers.get("logo.png"), "stats");
	assert.equal(result.block, "logo.png  +0 -0  (binary)");
});

test("reduces files matching a default exclude glob", () => {
	const result = evidence([staged({ path: "pnpm-lock.yaml" }), staged({ path: "src/a.ts" })]);
	assert.equal(result.tiers.get("pnpm-lock.yaml"), "reduced");
	assert.equal(result.tiers.get("src/a.ts"), "full");
});

test("reduces nested and directory exclude globs", () => {
	const result = evidence([
		staged({ path: "packages/app/pnpm-lock.yaml" }),
		staged({ path: "dist/assets/app-a81f9c.js" }),
		staged({ path: ".claude/settings.json" }),
	]);
	assert.deepEqual([...result.tiers.values()], ["reduced", "reduced", "reduced"]);
});

test("reduces files with an implausible mean changed-line length", () => {
	const result = evidence([staged({ path: "snapshot.sql", added: 1, deleted: 0, bytes: 400_000 })]);
	assert.equal(result.tiers.get("snapshot.sql"), "reduced");
});

test("keeps files with no changed lines out of the mean-length backstop", () => {
	const result = evidence([staged({ path: "mode.sh", added: 0, deleted: 0, bytes: 120, head: "old mode 100644\n" })]);
	assert.equal(result.tiers.get("mode.sh"), "full");
});

test("reduces files whose retained content was truncated", () => {
	const result = evidence([staged({ path: "src/big.ts", truncated: true, bytes: 8_000, added: 200, deleted: 100 })]);
	assert.equal(result.tiers.get("src/big.ts"), "reduced");
});

test("lets an include glob cancel a default exclude", () => {
	const result = evidence([staged({ path: "pnpm-lock.yaml" })], { include: ["**/pnpm-lock.yaml"] });
	assert.equal(result.tiers.get("pnpm-lock.yaml"), "full");
});

test("honors user exclude globs on top of the defaults", () => {
	const result = evidence([staged({ path: "docs/notes.md" })], { exclude: ["docs/**"] });
	assert.equal(result.tiers.get("docs/notes.md"), "reduced");
});

test("labels reduced excerpts as partial and counts the omitted lines", () => {
	const head = `diff --git a/uv.lock b/uv.lock\n--- a/uv.lock\n+++ b/uv.lock\n${Array.from({ length: 30 }, (_, index) => `+line ${index}`).join("\n")}\n`;
	const result = evidence([staged({ path: "uv.lock", head, added: 30, deleted: 0 })], { excerptLines: 5 });
	const lines = result.block.split("\n");
	assert.equal(lines[0], "uv.lock  +30 -0  (content reduced)");
	assert.deepEqual(lines.slice(1, 6), ["+line 0", "+line 1", "+line 2", "+line 3", "+line 4"]);
	assert.equal(lines.at(-1), "  ... 25 more changed lines omitted");
});

const body = (lines: number) => `diff --git a/x b/x\n${"+x\n".repeat(lines)}`;

test("grants full content smallest first and degrades the largest file", () => {
	const files = [
		staged({ path: "big.ts", head: body(200), added: 200, deleted: 0 }),
		staged({ path: "small.ts", head: body(10), added: 10, deleted: 0 }),
		staged({ path: "medium.ts", head: body(20), added: 20, deleted: 0 }),
	];
	const result = evidence(files, { byteBudget: 300 });
	assert.equal(result.tiers.get("small.ts"), "full");
	assert.equal(result.tiers.get("medium.ts"), "full");
	assert.notEqual(result.tiers.get("big.ts"), "full");
});

test("accounts for every file at an absurdly small budget", () => {
	const files = ["a.ts", "b.ts", "c.ts"].map((file) => staged({ path: file }));
	const result = evidence(files, { byteBudget: 1 });
	assert.deepEqual([...result.tiers.values()], ["stats", "stats", "stats"]);
	// Too small for one line per file, so the block reports the group they all belong to instead.
	assert.match(result.block, /3 files/);
	assert.equal(result.tiers.size, files.length);
});

test("aggregates into groups when one line per file will not fit", () => {
	const files = Array.from({ length: 5_000 }, (_, index) => staged({ path: `src/area${index % 10}/file${index}.ts` }));
	const result = evidence(files, { byteBudget: 8_000 });
	assert.ok(Buffer.byteLength(result.block) <= 8_000, `block was ${Buffer.byteLength(result.block)} bytes`);
	assert.equal(result.tiers.size, files.length);
	assert.match(result.summary, /aggregated into \d+ groups?/);
	// Aggregate lines must cover the whole set, not a sample of it.
	const counted = [...result.block.matchAll(/ {2}(\d+) files {2}\+/g)].reduce(
		(total, match) => total + Number(match[1]),
		0
	);
	assert.equal(counted, files.length);
});

test("keeps a huge file count inside the budget", () => {
	const files = Array.from({ length: 30_000 }, (_, index) => staged({ path: `generated/b${index % 60}/f${index}.ts` }));
	const result = evidence(files, { byteBudget: 64_000 });
	assert.ok(Buffer.byteLength(result.block) <= 64_000, `block was ${Buffer.byteLength(result.block)} bytes`);
});

test("keeps the rendered block inside the byte budget", () => {
	const files = Array.from({ length: 40 }, (_, index) =>
		staged({
			path: `src/module-${index}.ts`,
			head: `diff --git a/src/module-${index}.ts b/src/module-${index}.ts\n${`+line\n`.repeat(index * 20)}`,
			added: index * 20,
			deleted: 0,
		})
	);
	for (const byteBudget of [2_000, 10_000, 50_000]) {
		const result = buildEvidence(files, { byteBudget });
		assert.ok(Buffer.byteLength(result.block) <= byteBudget, `budget ${byteBudget}`);
	}
});

test("summarizes plainly when every file is sent in full", () => {
	const result = evidence([staged({ path: "a.ts" }), staged({ path: "b.ts" })]);
	assert.match(result.summary, /^2 files in full \(\d+ B\)$/);
});

test("summarizes the degraded files and the total diff size", () => {
	const result = evidence([
		staged({ path: "a.ts" }),
		staged({ path: "pnpm-lock.yaml", bytes: 5_000_000 }),
		staged({ path: "logo.png", binary: true }),
	]);
	assert.equal(result.summary, "1 file in full, 1 reduced to excerpts, 1 reduced to stats (5.0 MB)");
});

test("rolls directories up until the group count fits and covers every path", () => {
	const paths = Array.from({ length: 60 }, (_, index) => `src/area-${index}/nested/file-${index}.ts`);
	const groups = buildGroups(paths, 5);
	assert.ok(groups.length <= 5);
	assert.deepEqual(groups.flatMap((group) => group.paths).sort(), [...paths].sort());
	assert.deepEqual(
		groups.map((group) => group.id),
		groups.map((_, index) => `g${index + 1}`)
	);
});

test("keeps distinct directories apart when they already fit", () => {
	const groups = buildGroups(["src/a.ts", "src/b.ts", "test/c.ts"], 20);
	assert.deepEqual(groups, [
		{ id: "g1", prefix: "src", paths: ["src/a.ts", "src/b.ts"] },
		{ id: "g2", prefix: "test", paths: ["test/c.ts"] },
	]);
});

test("terminates at the repository root on deeply nested paths", () => {
	const paths = Array.from({ length: 30 }, (_, index) => `${"deep/".repeat(40)}branch-${index}/file.ts`);
	const groups = buildGroups(paths, 1);
	assert.equal(groups.length, 1);
	assert.deepEqual(groups[0]?.paths, paths);
	assert.equal(groups[0]?.prefix, "deep/".repeat(39) + "deep");
});

test("returns a single group for root-level paths", () => {
	const groups = buildGroups(["README.md", "package.json"], 1);
	assert.deepEqual(groups, [{ id: "g1", prefix: ".", paths: ["README.md", "package.json"] }]);
});

test("builds a fallback plan covering every path exactly once", () => {
	const paths = ["src/a.ts", "test/b.ts", "README.md"];
	const plan = buildFallbackPlan(paths);
	assert.equal(plan.commits.length, 1);
	assert.equal(plan.commits[0]?.subject, "chore: update 3 files");
	assert.equal(plan.commits[0]?.body, "");
	assert.deepEqual(plan.commits[0]?.files, paths);
});

test("scopes the fallback subject when every path shares a top-level directory", () => {
	assert.equal(buildFallbackPlan(["src/a.ts", "src/deep/b.ts"]).commits[0]?.subject, "chore(src): update 2 files");
	assert.equal(buildFallbackPlan(["src/a.ts"]).commits[0]?.subject, "chore(src): update 1 file");
	assert.equal(buildFallbackPlan(["README.md"]).commits[0]?.subject, "chore: update 1 file");
});
