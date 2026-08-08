import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { test } from "node:test";

import {
	classifyFailure,
	createBodyGenerator,
	extractJsonObject,
	extractSubjects,
	generateCommitBody,
	generateCommitPlan,
	validateGroupPlan,
	validatePlan,
	type PlanEvent,
} from "../src/ai.ts";
import type { Profile } from "../src/config.ts";
import type { StagedFile } from "../src/git.ts";

/**
 * A local OpenAI-shaped chat-completions endpoint. Never reaches the network: the profile under
 * test points at this server's own address. The profiles below name the `compatible` provider,
 * which is the one that speaks chat completions; `openai` defaults to the Responses API and would
 * need a second wire format for no extra coverage of gc itself. `closeAllConnections` is what keeps
 * the suite from hanging, since the undici pool keeps a socket alive after a successful reply and a
 * plain `close()` would wait on it for ever.
 */
async function startProviderDouble(options: { content: string; delayMs?: number }) {
	/** The raw request bodies the double was sent, for the tests that assert on what was asked. */
	const asked: string[] = [];
	const server = createServer((request, response) => {
		let received = "";
		request.on("data", (chunk: Buffer) => {
			received += chunk.toString();
		});
		const send = () => {
			asked.push(received);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					id: "double",
					object: "chat.completion",
					model: "m",
					choices: [{ index: 0, message: { role: "assistant", content: options.content }, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				})
			);
		};
		request.resume();
		if (options.delayMs) setTimeout(send, options.delayMs).unref();
		else request.on("end", send);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address === "object");
	return {
		asked,
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

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

test("subjects are recovered from a partially written response", () => {
	assert.deepEqual(extractSubjects(""), []);
	assert.deepEqual(extractSubjects('{"commits":[{"subject":"feat: a'), ["feat: a"]);
	assert.deepEqual(extractSubjects('{"commits":[{"subject":"feat: a","body":"","files":["x"]},{"subject":"fix: b'), [
		"feat: a",
		"fix: b",
	]);
	assert.deepEqual(extractSubjects('{"commits":[{"subject":"chore: say \\"hi\\" now'), ['chore: say "hi" now']);
	assert.deepEqual(extractSubjects('{"commits":[{"subject":"docs: a\\nb'), ["docs: a\nb"]);
});

test("retries are reported through onProgress", async () => {
	const events: string[] = [];
	let call = 0;
	await generateCommitPlan({
		profile: { provider: "openai", baseUrl: "https://example.invalid/v1", model: "m", apiKey: "k" },
		files: [{ path: "a.ts", status: "M", added: 1, deleted: 0, bytes: 10, head: "", truncated: false, binary: false }],
		paths: ["a.ts"],
		renames: [],
		history: [],
		context: { root: "/r", instructions: [], context: [] },
		split: false,
		body: "auto",
		onProgress: (event) => events.push(event.type),
		generate: async () => {
			if (call++ === 0) throw new Error("The response must contain at least one commit.");
			return { commits: [{ subject: "feat: x", body: "", files: ["a.ts"] }] };
		},
	});
	assert.ok(events.includes("retry"), `expected a retry event, saw ${events.join(", ")}`);
	assert.ok(events.includes("phase"));
});

/**
 * The retry machine is exercised through the injected `generate` seam everywhere else, which never
 * reaches `callModel`. These drive the real streaming path against a local server instead, because
 * `streamText` reports transport failures only through `onError`: reading `finishReason` first would
 * turn every one of them into an `AI_NoOutputGeneratedError` and reclassify it as transient.
 */
const streamingPlan = '{"commits":[{"subject":"feat: streamed","body":"why","files":["a.ts"]}]}';
let respond: (response: ServerResponse) => void = () => {};
const streamServer = createServer((request, response) => {
	request.resume();
	request.on("end", () => respond(response));
});

function sendStream(response: ServerResponse, pieces: string[], finishReason = "stop") {
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const content of pieces) {
		response.write(`data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: { content } }] })}\n\n`);
	}
	response.write(
		`data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`
	);
	response.end("data: [DONE]\n\n");
}

function planFrom(baseUrl: string, onProgress: (event: PlanEvent) => void) {
	return generateCommitPlan({
		profile: { provider: "compatible", baseUrl, model: "m", apiKey: "k" },
		files: [staged("a.ts")],
		paths: ["a.ts"],
		renames: [],
		history: [],
		context,
		split: false,
		body: "auto",
		onProgress,
	});
}

test("streams subjects from the provider and keeps failure classification intact", { timeout: 10_000 }, async (t) => {
	// The compatible provider warns that it cannot enforce a schema, which is noise here.
	const warnings = globalThis as { AI_SDK_LOG_WARNINGS?: boolean | undefined };
	const previousWarnings = warnings.AI_SDK_LOG_WARNINGS;
	warnings.AI_SDK_LOG_WARNINGS = false;
	t.after(() => {
		warnings.AI_SDK_LOG_WARNINGS = previousWarnings;
	});
	await new Promise<void>((resolve) => streamServer.listen(0, "127.0.0.1", resolve));
	t.after(() => streamServer.close());
	const address = streamServer.address();
	assert(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}/v1`;

	// Chunked so the subject arrives over several partial parses rather than in one piece.
	const pieces = streamingPlan.match(/[\s\S]{1,7}/g) ?? [];
	respond = (response) => sendStream(response, pieces);
	const events: PlanEvent[] = [];
	const plan = await planFrom(baseUrl, (event) => events.push(event));
	assert.equal(plan.commits[0]?.subject, "feat: streamed");
	assert.equal(plan.fallback, undefined);
	const subjects = events.filter((event) => event.type === "subject");
	assert.ok(subjects.length > 1, `expected progressive subjects, saw ${subjects.length}`);
	assert.deepEqual(subjects.at(-1), { type: "subject", index: 0, text: "feat: streamed" });

	// Fenced output cannot be coerced, so the raw text has to be salvaged instead.
	respond = (response) => sendStream(response, ["```json\n", streamingPlan, "\n```"]);
	assert.equal((await planFrom(baseUrl, () => {})).commits[0]?.subject, "feat: streamed");

	// A rendering bug in a progress consumer is not a provider failure. Unguarded it escapes the
	// stream loop, is classified transient, and is retried until the local fallback wins.
	respond = (response) => sendStream(response, pieces);
	const despiteConsumer = await planFrom(baseUrl, () => {
		throw new Error("the display exploded");
	});
	assert.equal(despiteConsumer.commits[0]?.subject, "feat: streamed");
	assert.equal(despiteConsumer.fallback, undefined);

	// A credential failure must still reach classifyFailure as itself, not as a stream-ended error.
	respond = (response) => {
		response.writeHead(401, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: { message: "Unauthorized" } }));
	};
	await assert.rejects(
		planFrom(baseUrl, () => {}),
		/Unauthorized/
	);

	/*
	 * And again on the plain-text path, which is the live one for every endpoint that refuses the
	 * schema: the first reply drops generateCommitPlan out of structured mode, so the 401 that
	 * follows arrives at the reader that has no `output` on it. Both readers must rethrow what
	 * `onError` captured before awaiting anything on the result, because after a stream has ended in
	 * an error those promises reject with a status-less "no output generated" that classifyFailure
	 * reads as transient: four blind retries and a silent local `chore:` plan on a dead key.
	 */
	let call = 0;
	respond = (response) => {
		const refusal =
			++call === 1
				? { status: 400, message: "response_format json_schema is not supported by this model" }
				: { status: 401, message: "Unauthorized while streaming plain text" };
		response.writeHead(refusal.status, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: { message: refusal.message } }));
	};
	await assert.rejects(
		planFrom(baseUrl, () => {}),
		/Unauthorized while streaming plain text/
	);
	// Two requests, not four: a 401 read as transient would have been repeated until the budget ran
	// out and a local `chore:` plan came back in place of the error.
	assert.equal(call, 2, "the 401 was fatal on the plain-text path too, not retried into a fallback");
});

/** Ask the double for a body, so the cases below differ only in what the model replied. */
async function bodyFrom(content: string, subject = "feat: x") {
	const server = await startProviderDouble({ content });
	try {
		return await generateCommitBody({
			profile: { provider: "compatible", baseUrl: server.baseUrl, model: "m", apiKey: "k" },
			subject,
			files: [
				{ path: "a.ts", status: "M", added: 1, deleted: 0, bytes: 10, head: "", truncated: false, binary: false },
			],
			context: { root: "/r", instructions: [], context: [] },
		});
	} finally {
		await server.close();
	}
}

test("generateCommitBody returns the model's prose and drops a repeated subject", { timeout: 10_000 }, async () => {
	assert.equal(
		await bodyFrom("feat: x\n\nBecause the old path could not express it."),
		"Because the old path could not express it."
	);
});

/**
 * Only a whole repeated subject line is dropped. Cutting `subject.length` off anything else leaves
 * the punctuation that followed it, which reads as garbage at the head of the commit body.
 */
test("generateCommitBody strips a repeated subject only when the whole line repeats", { timeout: 10_000 }, async () => {
	const subject = "feat(api): version the client";
	const restated = "feat(api): version the client, routes and errors\n\nBecause v1 leaked.";
	assert.equal(await bodyFrom(restated, subject), restated, "a longer opening is prose, not a repeat");

	const punctuated = "feat(api): version the client.\n\nBecause v1 leaked.";
	assert.equal(await bodyFrom(punctuated, subject), punctuated, "neither is the subject plus a full stop");

	// A reply that is the subject and nothing else leaves no body at all, which must not be written.
	await assert.rejects(bodyFrom(subject, subject), /nothing to add/);
	await assert.rejects(bodyFrom(`  ${subject}  \n\n `, subject), /nothing to add/);
});

/**
 * The shell writes whatever comes back straight onto the row, so an empty answer would wipe a body
 * the user already had. A reasoning model that spends the whole output ceiling before writing a
 * character produces exactly that, which is why this is a rejection rather than an empty string.
 */
test("generateCommitBody refuses an empty answer instead of returning one", { timeout: 10_000 }, async () => {
	await assert.rejects(bodyFrom(""), /nothing to add/);
	await assert.rejects(bodyFrom("   \n\n  "), /nothing to add/);
});

test(
	"generateCommitBody keeps oversized repository instructions from crowding out the diff",
	{ timeout: 10_000 },
	async () => {
		const server = await startProviderDouble({ content: "Because the guide said so." });
		try {
			await generateCommitBody({
				profile: { provider: "compatible", baseUrl: server.baseUrl, model: "m", apiKey: "k", maxInputTokens: 4_000 },
				subject: "feat: x",
				files: [staged("a.ts")],
				context: { root: "/r", instructions: [{ path: "AGENTS.md", content: "g".repeat(200_000) }], context: [] },
			});
			const prompt = server.asked[0] ?? "";
			// 4,000 tokens at two bytes each, halved for the body request, so a quarter of that is the
			// document share. The unclamped document alone was fifty times the whole prompt budget.
			assert.ok(Buffer.byteLength(prompt) < 8_192, `prompt was ${Buffer.byteLength(prompt)} bytes`);
			assert.match(prompt, /AGENTS\.md/, "the instruction is still named");
			assert.match(prompt, /a\.ts/, "and the diff still survives beside it");
		} finally {
			await server.close();
		}
	}
);

/**
 * The CLI and `pnpm demo` share this, because the harness online is the only end-to-end exercise
 * `generateCommitBody` gets: a harness that sends the whole staged set validates a prompt nobody
 * ships. A rename is the case the scoping used to lose, since it contributes two paths but one
 * staged record.
 */
test("the shared body generator sends one commit's files, old rename paths included", { timeout: 10_000 }, async () => {
	const server = await startProviderDouble({ content: "Because the old name no longer fit." });
	try {
		const generate = createBodyGenerator({
			profile: { provider: "compatible", baseUrl: server.baseUrl, model: "m", apiKey: "k" },
			plan: {
				commits: [
					{ subject: "refactor: rename greet to hello", body: "", files: ["src/greet.ts", "src/hello.ts"] },
					{ subject: "docs: refresh the readme", body: "", files: ["README.md"] },
				],
			},
			files: [staged("src/hello.ts"), staged("README.md")],
			renames: [["src/greet.ts", "src/hello.ts"]],
			context,
		});

		const body = await generate(0, "refactor: rename greet to hello", new AbortController().signal);
		assert.equal(body, "Because the old name no longer fit.");

		const prompt = server.asked[0] ?? "";
		assert.match(prompt, /src\/hello\.ts/, "the commit's own file is there");
		assert.match(prompt, /src\/greet\.ts -> src\/hello\.ts/, "and so is the path it replaced");
		assert.doesNotMatch(prompt, /README\.md/, "the other commit's files are not");

		await assert.rejects(generate(9, "feat: nothing", new AbortController().signal), /No such commit/);
	} finally {
		await server.close();
	}
});

test("generateCommitBody honours an abort signal", { timeout: 10_000 }, async () => {
	const server = await startProviderDouble({ delayMs: 5_000, content: "late" });
	try {
		const abort = new AbortController();
		const pending = generateCommitBody({
			profile: { provider: "compatible", baseUrl: server.baseUrl, model: "m", apiKey: "k" },
			subject: "feat: x",
			files: [
				{ path: "a.ts", status: "M", added: 1, deleted: 0, bytes: 10, head: "", truncated: false, binary: false },
			],
			context: { root: "/r", instructions: [], context: [] },
			signal: abort.signal,
		});
		abort.abort();
		await assert.rejects(pending);
	} finally {
		await server.close();
	}
});
