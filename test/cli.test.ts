import assert from "node:assert/strict";
import { test } from "node:test";

import { formatPlan, help, parseCliArgs, reviewPlan } from "../src/cli.ts";

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
});

test("edits one message then returns to the full review", async () => {
	const plan = { commits: [{ subject: "old", body: "", files: ["a.ts"] }] };
	const answers: unknown[] = ["edit", 0, "commit"];
	const action = await reviewPlan(plan, {
		select: async () => answers.shift() as never,
		editor: async () => "feat: new\n\nDetails",
	});
	assert.equal(action, "commit");
	assert.equal(plan.commits[0]?.subject, "feat: new");
	assert.equal(plan.commits[0]?.body, "Details");
	assert.match(formatPlan(plan), /a\.ts/);
});
