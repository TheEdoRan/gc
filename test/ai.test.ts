import assert from "node:assert/strict";
import { test } from "node:test";

import { generateCommitPlan, validatePlan } from "../src/ai.ts";
import type { Profile } from "../src/config.ts";

const profile: Profile = {
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	model: "test",
	apiKey: "secret",
};

test("validates exact file partitions, rename pairs, and disabled splitting", () => {
	const valid = {
		commits: [
			{ subject: "feat: move file", body: "", files: ["old.ts", "new.ts"] },
			{ subject: "test: add coverage", body: "", files: ["test.ts"] },
		],
	};
	assert.deepEqual(validatePlan(valid, ["old.ts", "new.ts", "test.ts"], [["old.ts", "new.ts"]], true), valid);
	assert.throws(() => validatePlan(valid, ["old.ts", "new.ts", "test.ts"], [], false), /disabled/);
	assert.throws(
		() =>
			validatePlan(
				{
					commits: [
						{ subject: "x", body: "", files: ["old.ts", "test.ts"] },
						{ subject: "y", body: "", files: ["new.ts"] },
					],
				},
				["old.ts", "new.ts", "test.ts"],
				[["old.ts", "new.ts"]],
				true
			),
		/rename/i
	);
	assert.throws(
		() => validatePlan({ commits: [{ subject: "x", body: "", files: ["old.ts", "old.ts"] }] }, ["old.ts"], [], true),
		/exactly once/
	);
});

test("retries invalid model output once with the validation error", async () => {
	const prompts: string[] = [];
	const plan = await generateCommitPlan({
		profile,
		diff: "diff",
		files: ["a.ts"],
		renames: [],
		history: [],
		context: { root: "/repo", instructions: [], context: [] },
		split: true,
		generate: async (prompt) => {
			prompts.push(prompt);
			return prompts.length === 1
				? { commits: [{ subject: "x", body: "", files: ["wrong.ts"] }] }
				: { commits: [{ subject: "feat: add a", body: "", files: ["a.ts"] }] };
		},
	});
	assert.equal(plan.commits[0]?.subject, "feat: add a");
	assert.equal(prompts.length, 2);
	assert.match(prompts[1]!, /previous response was invalid/i);
});
