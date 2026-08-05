import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, Output } from "ai";

import type { Profile } from "./config.ts";
import { buildPrompt, type RepositoryContext } from "./context.ts";

export interface ProposedCommit {
	subject: string;
	body: string;
	files: string[];
}

export interface CommitPlan {
	commits: ProposedCommit[];
}

const commitPlanSchema = jsonSchema<CommitPlan>({
	type: "object",
	additionalProperties: false,
	required: ["commits"],
	properties: {
		commits: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["subject", "body", "files"],
				properties: {
					subject: { type: "string", minLength: 1 },
					body: { type: "string" },
					files: { type: "array", minItems: 1, items: { type: "string" } },
				},
			},
		},
	},
});

export function validatePlan(
	plan: unknown,
	files: string[],
	renames: Array<[string, string]>,
	split: boolean
): CommitPlan {
	if (
		!plan ||
		typeof plan !== "object" ||
		!Array.isArray((plan as CommitPlan).commits) ||
		!(plan as CommitPlan).commits.length
	) {
		throw new Error("The response must contain at least one commit.");
	}
	const commits = (plan as CommitPlan).commits;
	for (const commit of commits) {
		if (
			!commit ||
			typeof commit.subject !== "string" ||
			!commit.subject.trim() ||
			typeof commit.body !== "string" ||
			!Array.isArray(commit.files) ||
			!commit.files.length ||
			commit.files.some((file) => typeof file !== "string")
		) {
			throw new Error("Each commit needs a subject, body, and at least one file.");
		}
	}
	if (!split && commits.length !== 1) throw new Error("Splitting is disabled, so exactly one commit is required.");
	const assigned = commits.flatMap((commit) => commit.files);
	const expected = new Set(files);
	const counts = new Map<string, number>();
	for (const file of assigned) counts.set(file, (counts.get(file) ?? 0) + 1);
	const duplicates = assigned.filter((file) => counts.get(file)! > 1);
	const missing = files.filter((file) => !counts.has(file));
	const unknown = assigned.filter((file) => !expected.has(file));
	if (duplicates.length || missing.length || unknown.length) {
		throw new Error(
			`Files must appear exactly once.${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}${duplicates.length ? ` Repeated: ${[...new Set(duplicates)].join(", ")}.` : ""}${unknown.length ? ` Unknown: ${[...new Set(unknown)].join(", ")}.` : ""}`
		);
	}
	for (const [from, to] of renames) {
		if (
			commits.findIndex((commit) => commit.files.includes(from)) !==
			commits.findIndex((commit) => commit.files.includes(to))
		) {
			throw new Error(`Rename paths must remain together: ${from}, ${to}.`);
		}
	}
	return { commits: commits.map((commit) => ({ ...commit, subject: commit.subject.trim() })) };
}

function modelFor(profile: Profile) {
	if (profile.provider === "openai") {
		return createOpenAI({ apiKey: profile.apiKey, baseURL: profile.baseUrl })(profile.model);
	}
	if (profile.provider === "anthropic") {
		return createAnthropic({ apiKey: profile.apiKey, baseURL: profile.baseUrl })(profile.model);
	}
	return createOpenAICompatible({
		name: "compatible",
		...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
		baseURL: profile.baseUrl,
	})(profile.model);
}

async function callModel(profile: Profile, prompt: string, structured = true): Promise<unknown> {
	const model = modelFor(profile);
	if (structured) {
		return (await generateText({ model, prompt, output: Output.object({ schema: commitPlanSchema }) })).output;
	}
	const { text } = await generateText({
		model,
		prompt: `${prompt}\nReturn JSON only, matching {"commits":[{"subject":"...","body":"...","files":["..."]}]}.`,
	});
	return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
}

export async function generateCommitPlan(input: {
	profile: Profile;
	diff: string;
	files: string[];
	renames: Array<[string, string]>;
	history: string[];
	context: RepositoryContext;
	split: boolean;
	instructions?: string;
	generate?: (prompt: string, structured: boolean) => Promise<unknown>;
}): Promise<CommitPlan> {
	const generate = input.generate ?? ((prompt, structured) => callModel(input.profile, prompt, structured));
	let validationError: string | undefined;
	for (let attempt = 0; attempt < 2; attempt++) {
		const prompt = buildPrompt({ ...input, ...(validationError ? { validationError } : {}) });
		let output: unknown;
		try {
			output = await generate(prompt, true);
		} catch (error) {
			if (input.profile.provider !== "compatible") throw error;
			output = await generate(prompt, false);
		}
		try {
			return validatePlan(output, input.files, input.renames, input.split);
		} catch (error) {
			validationError = error instanceof Error ? error.message : String(error);
		}
	}
	throw new Error(`AI returned an invalid plan twice: ${validationError}`);
}
