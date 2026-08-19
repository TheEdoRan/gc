import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { help, openConfig, parseCliArgs } from "../src/cli.ts";
import { reviewCommits } from "../src/review.ts";

test("parses public CLI arguments", () => {
	assert.deepEqual(parseCliArgs([]), { command: "commit", all: false });
	assert.deepEqual(parseCliArgs(["-a", "-i", "focus", "--no-split"]), {
		command: "commit",
		all: true,
		instructions: "focus",
		split: false,
	});
	assert.deepEqual(parseCliArgs(["profile", "work"]), { command: "profile", name: "work", all: false });
	assert.deepEqual(parseCliArgs(["setup"]), { command: "setup", all: false });
	assert.deepEqual(parseCliArgs(["config"]), { command: "config", all: false });
	assert.deepEqual(parseCliArgs(["--help"]), { command: "help", all: false });
	assert.deepEqual(parseCliArgs(["--version"]), { command: "version", all: false });
	assert.throws(() => parseCliArgs(["--split", "--no-split"]), /cannot be used together/);
	assert.match(help, /gc profile \[name\]/);
	assert.match(help, /gc setup/);
	assert.match(help, /gc config/);
});

void test("opens the config file in the preferred editor", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gc-open-config-"));
	const path = join(directory, "config.yaml");
	await writeFile(path, "activeProfile: personal\n");
	openConfig(path, {
		bin: process.execPath,
		args: ["--eval", 'require("node:fs").appendFileSync(process.argv[1], "# edited\\n")'],
	});
	assert.match(await readFile(path, "utf8"), /# edited/);
	assert.throws(() => openConfig(join(directory, "missing.yaml")), /Run gc init first/);
});

test("parses the body flag", () => {
	assert.deepEqual(parseCliArgs(["--body", "always"]), { command: "commit", all: false, body: "always" });
	assert.throws(() => parseCliArgs(["--body", "sometimes"]), /manual, auto, always/);
	// The subcommands take no commit options, and --body is one of them.
	assert.throws(() => parseCliArgs(["init", "--body", "auto"]), /cannot be used with gc init/);
	assert.throws(() => parseCliArgs(["setup", "--body", "auto"]), /cannot be used with gc setup/);
	assert.throws(() => parseCliArgs(["profile", "--body", "auto"]), /cannot be used with gc profile/);
});

test("the review prompt replaces the old preview helpers", async () => {
	const cli: Record<string, unknown> = await import("../src/cli.ts");
	assert.equal(cli.formatPlan, undefined);
	assert.equal(cli.reviewPlan, undefined);
	assert.equal(typeof reviewCommits, "function");
});
