import assert from "node:assert/strict";
import { test } from "node:test";

import { help, parseCliArgs } from "../src/cli.ts";
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
	assert.deepEqual(parseCliArgs(["--help"]), { command: "help", all: false });
	assert.deepEqual(parseCliArgs(["--version"]), { command: "version", all: false });
	assert.throws(() => parseCliArgs(["--split", "--no-split"]), /cannot be used together/);
	assert.match(help, /gc profile \[name\]/);
});

test("parses the body flag", () => {
	assert.deepEqual(parseCliArgs(["--body", "always"]), { command: "commit", all: false, body: "always" });
	assert.throws(() => parseCliArgs(["--body", "sometimes"]), /manual, auto, always/);
	// The subcommands take no commit options, and --body is one of them.
	assert.throws(() => parseCliArgs(["init", "--body", "auto"]), /cannot be used with gc init/);
	assert.throws(() => parseCliArgs(["profile", "--body", "auto"]), /cannot be used with gc profile/);
});

test("the review prompt replaces the old preview helpers", async () => {
	const cli: Record<string, unknown> = await import("../src/cli.ts");
	assert.equal(cli.formatPlan, undefined);
	assert.equal(cli.reviewPlan, undefined);
	assert.equal(typeof reviewCommits, "function");
});
