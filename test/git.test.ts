import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { batchPathspecs, createCommits, readRepository } from "../src/git.ts";

function run(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function repository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "gc-git-"));
	run(root, "init", "-q");
	run(root, "config", "user.name", "GC Test");
	run(root, "config", "user.email", "gc@example.test");
	run(root, "config", "commit.gpgsign", "false");
	return root;
}

void test("reads staged paths, renames, history, and stages all changes", async () => {
	const root = await repository();
	await writeFile(join(root, "old.txt"), "old\n");
	run(root, "add", "old.txt");
	run(root, "commit", "-qm", "initial subject");
	run(root, "mv", "old.txt", "new.txt");
	await writeFile(join(root, "untracked.txt"), "new\n");

	const changes = await readRepository(root, true);

	assert.deepEqual(changes.paths.toSorted(), ["new.txt", "old.txt", "untracked.txt"]);
	assert.deepEqual(changes.renames, [{ from: "old.txt", to: "new.txt" }]);
	assert.deepEqual(changes.history, ["initial subject"]);

	const untracked = changes.files.find((file) => file.path === "untracked.txt");
	assert.ok(untracked);
	assert.equal(untracked.status, "A");
	assert.equal(untracked.added, 1);
	assert.equal(untracked.deleted, 0);
	assert.equal(untracked.binary, false);
	assert.equal(untracked.truncated, false);
	assert.match(untracked.head, /^diff --git a\/untracked\.txt b\/untracked\.txt\n/);
	assert.match(untracked.head, /\n\+new\n$/);

	const renamed = changes.files.find((file) => file.path === "new.txt");
	assert.ok(renamed);
	assert.match(renamed.status, /^R/);
});

void test("streams a large diff with exact counts and a bounded head", async () => {
	const root = await repository();
	const lines = 200_000;
	await writeFile(
		join(root, "big.txt"),
		`${Array.from({ length: lines }, (_, index) => `line ${index}`).join("\n")}\n`
	);
	run(root, "add", ".");
	run(root, "commit", "-qm", "base");
	await writeFile(
		join(root, "big.txt"),
		`${Array.from({ length: lines }, (_, index) => `LINE ${index}`).join("\n")}\n`
	);
	await writeFile(join(root, "small.txt"), "small\n");
	run(root, "add", ".");

	const changes = await readRepository(root);
	const big = changes.files.find((file) => file.path === "big.txt");
	assert.ok(big);

	const [added, deleted] = run(root, "diff", "--cached", "--numstat", "--", "big.txt").split("\t");
	assert.equal(big.added, Number(added));
	assert.equal(big.deleted, Number(deleted));
	assert.equal(big.truncated, true);
	assert.ok(big.bytes > 4_000_000, `expected a multi-megabyte section, got ${big.bytes}`);
	assert.ok(Buffer.byteLength(big.head) <= 8_192, `head was ${Buffer.byteLength(big.head)} bytes`);
	assert.ok(big.head.startsWith("diff --git a/big.txt b/big.txt\n"));

	const total = changes.files.reduce((sum, file) => sum + Buffer.byteLength(file.head), 0);
	assert.ok(total <= 262_144, `retained ${total} bytes`);
});

void test("reports binary files without counting lines", async () => {
	const root = await repository();
	await writeFile(join(root, "blob.bin"), Buffer.from(Array.from({ length: 4_096 }, (_, index) => index % 251)));
	run(root, "add", ".");

	const blob = (await readRepository(root)).files.find((file) => file.path === "blob.bin");
	assert.ok(blob);
	assert.equal(blob.binary, true);
	assert.equal(blob.added, 0);
	assert.equal(blob.deleted, 0);
});

void test("passes CRLF content and non-ASCII paths through byte-faithfully", async () => {
	const root = await repository();
	await writeFile(join(root, "café-üñi.txt"), "alpha\r\nbeta\r\n");
	run(root, "add", ".");

	const changes = await readRepository(root);
	const file = changes.files.find((entry) => entry.path === "café-üñi.txt");
	assert.ok(file, `paths were ${JSON.stringify(changes.paths)}`);
	assert.equal(file.added, 2);
	assert.ok(file.head.includes("+alpha\r\n+beta\r\n"), JSON.stringify(file.head));
	assert.ok(file.head.includes("café-üñi.txt"));
	assert.ok(!file.head.includes("�"));
});

void test("keeps retention bounded across many small files", async () => {
	const root = await repository();
	const count = 60;
	for (let index = 0; index < count; index++) {
		await writeFile(join(root, `file-${index}.txt`), "payload line\n".repeat(200));
	}
	run(root, "add", ".");

	const budget = 4_096;
	const changes = await readRepository(root, false, budget);
	assert.equal(changes.files.length, count);
	for (const path of changes.paths)
		assert.ok(
			changes.files.some((file) => file.path === path),
			path
		);

	const total = changes.files.reduce((sum, file) => sum + Buffer.byteLength(file.head), 0);
	// The per-file cap has a 256 byte floor, so that is the bound once the budget alone cannot be met.
	assert.ok(total <= Math.max(budget, 256 * count), `retained ${total} bytes`);
	for (const file of changes.files) {
		assert.equal(file.added, 200);
		assert.equal(file.truncated, true);
	}
});

void test("batches pathspecs under the argv budget and keeps rename sides together", () => {
	const files = ["a.txt", "b.txt", "old.txt", "new.txt", "c.txt"];
	const batches = batchPathspecs(files, [{ from: "old.txt", to: "new.txt" }], 40);

	assert.ok(batches.length > 1, `expected multiple batches, got ${JSON.stringify(batches)}`);
	assert.deepEqual(batches.flat().toSorted(), files.toSorted());
	const pair = batches.find((batch) => batch.includes("old.txt"));
	assert.ok(pair?.includes("new.txt"), `rename split across batches: ${JSON.stringify(batches)}`);
	for (const batch of batches) {
		const size = batch.reduce((total, path) => total + Buffer.byteLength(path) + 8, 0);
		assert.ok(size <= 40 || batch.length <= 2, `batch too large: ${JSON.stringify(batch)}`);
	}

	assert.deepEqual(batchPathspecs(files, []), [files]);
});

void test("split commits preserve binary data and unstaged hunks", async () => {
	const root = await repository();
	await writeFile(join(root, "partial.txt"), "one\ntwo\n");
	await writeFile(join(root, "image.bin"), Buffer.from([0, 1, 2]));
	run(root, "add", ".");
	run(root, "commit", "-qm", "base");

	await writeFile(join(root, "partial.txt"), "ONE\ntwo\n");
	await writeFile(join(root, "image.bin"), Buffer.from([0, 255, 2, 3]));
	run(root, "add", ".");
	await writeFile(join(root, "partial.txt"), "ONE\nTWO\n");

	await createCommits(root, [
		{ subject: "change text", files: ["partial.txt"] },
		{ subject: "change binary", files: ["image.bin"] },
	]);

	assert.deepEqual(run(root, "log", "-2", "--format=%s").split("\n"), ["change binary", "change text"]);
	assert.equal(run(root, "diff", "--cached"), "");
	assert.match(run(root, "diff"), /\+TWO/);
	assert.deepEqual(await readFile(join(root, "image.bin")), Buffer.from([0, 255, 2, 3]));
});

void test("a later failure keeps earlier commits and restores remaining staged patches", async () => {
	const root = await repository();
	await writeFile(join(root, "one.txt"), "one\n");
	await writeFile(join(root, "two.txt"), "two\n");
	run(root, "add", ".");
	const hook = join(root, ".git", "hooks", "commit-msg");
	await writeFile(hook, '#!/bin/sh\ngrep -q "^second" "$1" && exit 1\nexit 0\n');
	await chmod(hook, 0o755);

	await assert.rejects(
		createCommits(root, [
			{ subject: "first", files: ["one.txt"] },
			{ subject: "second", files: ["two.txt"] },
		])
	);

	assert.equal(run(root, "log", "-1", "--format=%s"), "first");
	assert.equal(run(root, "diff", "--cached", "--name-only"), "two.txt");
	assert.equal(run(root, "show", "HEAD:one.txt"), "one");
	assert.throws(() => run(root, "show", "HEAD:two.txt"));
});

void test("rejects an incomplete split without changing the index", async () => {
	const root = await repository();
	await writeFile(join(root, "one.txt"), "one\n");
	await writeFile(join(root, "two.txt"), "two\n");
	run(root, "add", ".");

	await assert.rejects(
		createCommits(root, [
			{ subject: "one", files: ["one.txt"] },
			{ subject: "empty", files: [] },
		]),
		/contain every staged path exactly once/
	);
	assert.deepEqual(run(root, "diff", "--cached", "--name-only").split("\n"), ["one.txt", "two.txt"]);
});
