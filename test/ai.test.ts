import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyFailure, extractJsonObject, generateCommitPlan, validateGroupPlan, validatePlan } from "../src/ai.ts";
import type { Profile } from "../src/config.ts";
import type { StagedFile } from "../src/git.ts";

const profile: Profile = {
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	model: "test",
	apiKey: "secret",
};

const context = { root: "/repo", instructions: [], context: [] };

function staged(filePath: string, overrides: Partial<StagedFile> = {}): StagedFile {
	const head = overrides.head ?? `diff --git a/${filePath} b/${filePath}\n@@ -1 +1 @@\n-old line\n+new line\n`;
	return {
		path: filePath,
		status: "M",
		added: 1,
		deleted: 1,
		bytes: Buffer.byteLength(head),
		head,
		truncated: false,
		binary: false,
		...overrides,
	};
}

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

test("expands group ids back to exact paths locally", () => {
	const groups = [
		{ id: "g1", prefix: "src", paths: ["src/a.ts", "src/b.ts"] },
		{ id: "g2", prefix: "docs", paths: ["docs/readme.md"] },
	];
	const plan = validateGroupPlan(
		{
			commits: [
				{ subject: "feat: rework src", body: "", groups: ["g1"] },
				{ subject: "docs: refresh", body: "", groups: ["g2"] },
			],
		},
		groups,
		true
	);
	assert.deepEqual(plan.commits[0]?.files, ["src/a.ts", "src/b.ts"]);
	assert.deepEqual(plan.commits[1]?.files, ["docs/readme.md"]);
	assert.throws(() => validateGroupPlan({ commits: [{ subject: "x", body: "", groups: ["g1"] }] }, groups, true), /g2/);
	assert.throws(
		() => validateGroupPlan({ commits: [{ subject: "x", body: "", groups: ["g9"] }] }, groups, true),
		/Unknown: g9/
	);
});

test("retries invalid model output once with the validation error", async () => {
	const prompts: string[] = [];
	const plan = await generateCommitPlan({
		profile,
		files: [staged("a.ts")],
		paths: ["a.ts"],
		renames: [],
		history: [],
		context,
		split: true,
		body: "auto",
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
	assert.ok(!plan.fallback);
});

test("makes exactly one model call for an oversized diff", async () => {
	const huge = `diff --git a/large.ts b/large.ts\n${"+x".repeat(400_000)}\n`;
	const prompts: string[] = [];
	const plan = await generateCommitPlan({
		profile,
		files: [staged("large.ts", { head: huge, bytes: 4_000_000, added: 400_000, truncated: true })],
		paths: ["large.ts"],
		renames: [],
		history: [],
		context,
		split: false,
		body: "auto",
		generate: async (prompt) => {
			prompts.push(prompt);
			return { commits: [{ subject: "feat: update large", body: "", files: ["large.ts"] }] };
		},
	});
	assert.equal(prompts.length, 1);
	assert.equal(plan.commits[0]?.subject, "feat: update large");
	// 32,000 tokens at two bytes per token, with headroom for the fixed scaffolding.
	assert.ok(Buffer.byteLength(prompts[0]!) <= 64_000 + 8_192);
	assert.match(prompts[0]!, /content reduced|content omitted/);
});

test("switches to group ids when the path echo cannot fit the output budget", async () => {
	const paths = Array.from({ length: 4_000 }, (_, index) => `src/module${index}/file${index}.ts`);
	let prompt = "";
	const plan = await generateCommitPlan({
		profile,
		files: paths.map((filePath) => staged(filePath)),
		paths,
		renames: [],
		history: [],
		context,
		split: false,
		body: "auto",
		generate: async (text) => {
			prompt = text;
			const ids = [...text.matchAll(/^(g\d+)\s{2}/gm)].map((match) => match[1]!);
			return { commits: [{ subject: "chore: bulk update", body: "", groups: ids }] };
		},
	});
	assert.match(prompt, /assign every group id exactly once/);
	assert.equal(plan.commits.length, 1);
	assert.equal(plan.commits[0]?.files.length, paths.length);
	assert.deepEqual([...(plan.commits[0]?.files ?? [])].sort(), [...paths].sort());
});

test("halves the budget and retries when the provider rejects the prompt length", async () => {
	const sizes: number[] = [];
	const plan = await generateCommitPlan({
		profile,
		files: [staged("a.ts")],
		paths: ["a.ts"],
		renames: [],
		history: [],
		context,
		split: false,
		body: "auto",
		generate: async (prompt) => {
			sizes.push(Buffer.byteLength(prompt));
			if (sizes.length === 1) throw new Error("400 prompt is too long: 40000 tokens > 8192 maximum");
			return { commits: [{ subject: "feat: add a", body: "", files: ["a.ts"] }] };
		},
	});
	assert.equal(sizes.length, 2);
	assert.equal(plan.commits[0]?.subject, "feat: add a");
	assert.ok(!plan.fallback);
});

test("retries a transient failure before falling back to a local plan", async () => {
	let calls = 0;
	const plan = await generateCommitPlan({
		profile,
		files: [staged("src/a.ts"), staged("src/b.ts")],
		paths: ["src/a.ts", "src/b.ts"],
		renames: [],
		history: [],
		context,
		split: true,
		body: "auto",
		generate: async () => {
			calls++;
			throw new Error("fetch failed: ECONNREFUSED");
		},
	});
	// A dropped connection says nothing about the request, so it is repeated rather than surrendered.
	assert.ok(calls > 1, `expected more than one attempt, got ${calls}`);
	assert.equal(plan.fallback, true);
	assert.match(plan.failureReason ?? "", /ECONNREFUSED/);
	assert.equal(plan.commits.length, 1);
	assert.deepEqual(plan.commits[0]?.files, ["src/a.ts", "src/b.ts"]);
	assert.ok(plan.commits[0]?.subject.trim());
});

test("recovers when a transient failure clears", async () => {
	let calls = 0;
	const plan = await generateCommitPlan({
		profile,
		files: [staged("a.ts")],
		paths: ["a.ts"],
		renames: [],
		history: [],
		context,
		split: false,
		body: "auto",
		generate: async () => {
			if (++calls === 1) throw new Error("429 rate limit exceeded");
			return { commits: [{ subject: "feat: add a", body: "", files: ["a.ts"] }] };
		},
	});
	assert.equal(calls, 2);
	assert.ok(!plan.fallback);
	assert.equal(plan.commits[0]?.subject, "feat: add a");
});

test("drops to unstructured output only when the provider refuses a schema", async () => {
	const modes: boolean[] = [];
	const plan = await generateCommitPlan({
		profile,
		files: [staged("a.ts")],
		paths: ["a.ts"],
		renames: [],
		history: [],
		context,
		split: false,
		body: "auto",
		generate: async (_prompt, structured) => {
			modes.push(structured);
			if (modes.length === 1) throw new Error("400 response_format json_schema is not supported by this model");
			return { commits: [{ subject: "feat: add a", body: "", files: ["a.ts"] }] };
		},
	});
	assert.deepEqual(modes, [true, false]);
	assert.ok(!plan.fallback);
});

test("keeps structured output when the failure says nothing about schemas", async () => {
	const modes: boolean[] = [];
	await generateCommitPlan({
		profile,
		files: [staged("a.ts")],
		paths: ["a.ts"],
		renames: [],
		history: [],
		context,
		split: false,
		body: "auto",
		generate: async (_prompt, structured) => {
			modes.push(structured);
			throw new Error("The operation was aborted due to timeout");
		},
	});
	assert.deepEqual(
		modes.filter((mode) => !mode),
		[]
	);
});

test("lowers the output ceiling, not the diff, when the provider refuses max_tokens", async () => {
	const sizes: number[] = [];
	const plan = await generateCommitPlan({
		profile,
		files: [staged("a.ts")],
		paths: ["a.ts"],
		renames: [],
		history: [],
		context,
		split: false,
		body: "auto",
		generate: async (prompt) => {
			sizes.push(Buffer.byteLength(prompt));
			if (sizes.length === 1) throw new Error("400 max_tokens is greater than the maximum allowed for this model");
			return { commits: [{ subject: "feat: add a", body: "", files: ["a.ts"] }] };
		},
	});
	assert.equal(sizes.length, 2);
	// The prompt is untouched: only the answer was too big to ask for.
	assert.equal(sizes[0], sizes[1]);
	assert.ok(!plan.fallback);
});

test("throws instead of hiding an unusable configuration behind a local plan", async () => {
	await assert.rejects(
		generateCommitPlan({
			profile,
			files: [staged("a.ts")],
			paths: ["a.ts"],
			renames: [],
			history: [],
			context,
			split: false,
			body: "auto",
			generate: async () => {
				throw new Error("401 Unauthorized: invalid api key");
			},
		}),
		/api key/i
	);
});

test("states the required response shape in every prompt", async () => {
	let prompt = "";
	await generateCommitPlan({
		profile,
		files: [staged("a.ts")],
		paths: ["a.ts"],
		renames: [],
		history: [],
		context,
		split: false,
		body: "auto",
		generate: async (text) => {
			prompt = text;
			return { commits: [{ subject: "feat: add a", body: "", files: ["a.ts"] }] };
		},
	});
	assert.match(prompt, /"commits"/);
	assert.match(prompt, /"subject"/);
	assert.match(prompt, /"body"/);
	assert.match(prompt, /"files"/);
	// Some endpoints refuse to emit JSON unless the prompt says the word.
	assert.match(prompt, /json/i);
});

test("recovers JSON from fences and surrounding prose", () => {
	assert.deepEqual(extractJsonObject('```json\n{"commits":[]}\n```'), { commits: [] });
	assert.deepEqual(extractJsonObject('Here is the plan {see below}:\n{"commits":[{"subject":"a"}]}\nDone.'), {
		commits: [{ subject: "a" }],
	});
	assert.deepEqual(extractJsonObject('{"body":"a } brace in a string","ok":true}'), {
		body: "a } brace in a string",
		ok: true,
	});
	assert.throws(() => extractJsonObject(""), /empty/i);
	assert.throws(() => extractJsonObject("no object here"), /no JSON object/i);
	assert.throws(() => extractJsonObject('{"commits": ['), /unterminated/i);
});

test("classifies provider failures by what they say to change", () => {
	assert.equal(classifyFailure(new Error("400 max_tokens must be at most 8192")), "output-limit");
	assert.equal(classifyFailure(new Error("400 prompt is too long: 40000 tokens")), "input-limit");
	assert.equal(classifyFailure(new Error("this model's maximum context length is 8192 tokens")), "input-limit");
	assert.equal(classifyFailure(new Error("response_format json_schema unavailable")), "response-format");
	assert.equal(classifyFailure(new Error("401 Unauthorized")), "fatal");
	assert.equal(classifyFailure(new Error("fetch failed")), "transient");
});

test("falls back to a local plan when validation never succeeds", async () => {
	const plan = await generateCommitPlan({
		profile,
		files: [staged("a.ts")],
		paths: ["a.ts"],
		renames: [],
		history: [],
		context,
		split: true,
		body: "auto",
		generate: async () => ({ commits: [{ subject: "x", body: "", files: ["nope.ts"] }] }),
	});
	assert.equal(plan.fallback, true);
	assert.deepEqual(plan.commits[0]?.files, ["a.ts"]);
});

test("reports what the model was shown", async () => {
	const plan = await generateCommitPlan({
		profile,
		files: [staged("a.ts"), staged("pnpm-lock.yaml", { added: 900, deleted: 400, bytes: 900_000 })],
		paths: ["a.ts", "pnpm-lock.yaml"],
		renames: [],
		history: [],
		context,
		split: false,
		body: "auto",
		generate: async () => ({
			commits: [{ subject: "chore: bump deps", body: "", files: ["a.ts", "pnpm-lock.yaml"] }],
		}),
	});
	assert.ok(plan.notice);
	assert.match(plan.notice ?? "", /reduced/);
});

test("manual clears every body the model returns", async () => {
	const plan = await generateCommitPlan({
		profile: { provider: "openai", baseUrl: "https://example.invalid/v1", model: "m", apiKey: "k" },
		files: [{ path: "a.ts", status: "M", added: 1, deleted: 0, bytes: 10, head: "", truncated: false, binary: false }],
		paths: ["a.ts"],
		renames: [],
		history: [],
		context: { root: "/r", instructions: [], context: [] },
		split: false,
		body: "manual",
		generate: async () => ({ commits: [{ subject: "feat: x", body: "an unwanted body", files: ["a.ts"] }] }),
	});
	assert.equal(plan.commits[0]?.body, "");
	assert.equal(plan.commits[0]?.subject, "feat: x");
});
