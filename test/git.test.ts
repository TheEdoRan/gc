import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCommits, readRepository } from "../src/git.ts";

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
	assert.match(changes.diff, /untracked\.txt/);
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
