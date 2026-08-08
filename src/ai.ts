import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, NoObjectGeneratedError, Output } from "ai";

import type { BodyMode, Profile } from "./config.ts";
import { buildPrompt, type PromptGroup, type RepositoryContext } from "./context.ts";
import { buildEvidence, buildFallbackPlan, buildGroups } from "./evidence.ts";
import type { StagedFile } from "./git.ts";

export interface ProposedCommit {
	subject: string;
	body: string;
	files: string[];
}

export interface CommitPlan {
	commits: ProposedCommit[];
	/** One line describing what the model was shown, rendered above the plan preview. */
	notice?: string;
	/** True when the provider failed and this plan was built locally. */
	fallback?: boolean;
	/** Why the provider was given up on. Set only alongside `fallback`. */
	failureReason?: string;
}

export const DEFAULT_MAX_INPUT_TOKENS = 32_000;
/**
 * Unified diffs tokenize worse than prose: the +/-/space prefix breaks the newline-plus-indent
 * merge token that makes source code compress well, repeated context lines get no BPE discount,
 * and current tokenizers emit roughly 30% more tokens than older ones. Two bytes per token is the
 * conservative bound; a provider that still rejects the prompt halves the budget and retries.
 */
const BYTES_PER_TOKEN = 2;
/**
 * The ceiling passed to the provider. Reasoning models spend an invisible and unbudgetable share
 * of it before emitting a single character of the plan, so this is deliberately far above what the
 * plan text needs. A model that rejects the ceiling gets it halved rather than being given up on.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const MIN_INPUT_TOKENS = 2_000;
const MIN_OUTPUT_TOKENS = 1_024;
/** Share of the output ceiling the plan text itself may occupy, the rest being reasoning headroom. */
const ECHO_SHARE = 4;
/** One request. Reasoning models routinely take a minute before the first content token. */
const REQUEST_TIMEOUT_MS = 120_000;
/** The whole planning operation, across every retry, so a bad provider cannot hang the CLI. */
const TOTAL_DEADLINE_MS = 180_000;
const MAX_NETWORK_CALLS = 4;
/** Attempts spent on a model that answers but answers wrongly, before the local plan wins. */
const MAX_CONTENT_FAILURES = 2;
/** Keep retry feedback from crowding out the diff when thousands of paths are missing. */
const MAX_FEEDBACK_BYTES = 2_048;
/** Room for the fixed prompt scaffolding, history, and rename pairs. */
const SCAFFOLDING_BYTES = 4_096;

const commitPlanSchema = jsonSchema({
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

interface GroupCommit {
	subject: string;
	body: string;
	groups: string[];
}

const groupPlanSchema = jsonSchema({
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
				required: ["subject", "body", "groups"],
				properties: {
					subject: { type: "string", minLength: 1 },
					body: { type: "string" },
					groups: { type: "array", minItems: 1, items: { type: "string" } },
				},
			},
		},
	},
});

function assertCommitShape(commit: { subject?: unknown; body?: unknown }) {
	if (!commit || typeof commit.subject !== "string" || !commit.subject.trim() || typeof commit.body !== "string") {
		throw new Error("Each commit needs a subject and a body.");
	}
}

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
		assertCommitShape(commit);
		if (!Array.isArray(commit.files) || !commit.files.length || commit.files.some((file) => typeof file !== "string")) {
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

/** Validate the group-mode response and expand group ids back to exact paths locally. */
export function validateGroupPlan(plan: unknown, groups: PromptGroup[], split: boolean): CommitPlan {
	const commits = (plan as { commits?: GroupCommit[] } | null)?.commits;
	if (!plan || typeof plan !== "object" || !Array.isArray(commits) || !commits.length) {
		throw new Error("The response must contain at least one commit.");
	}
	for (const commit of commits) {
		assertCommitShape(commit);
		if (!Array.isArray(commit.groups) || !commit.groups.length || commit.groups.some((id) => typeof id !== "string")) {
			throw new Error("Each commit needs a subject, body, and at least one group id.");
		}
	}
	if (!split && commits.length !== 1) throw new Error("Splitting is disabled, so exactly one commit is required.");

	const byId = new Map(groups.map((group) => [group.id, group]));
	const assigned = commits.flatMap((commit) => commit.groups);
	const counts = new Map<string, number>();
	for (const id of assigned) counts.set(id, (counts.get(id) ?? 0) + 1);
	const duplicates = [...new Set(assigned.filter((id) => counts.get(id)! > 1))];
	const missing = groups.filter((group) => !counts.has(group.id)).map((group) => group.id);
	const unknown = [...new Set(assigned.filter((id) => !byId.has(id)))];
	if (duplicates.length || missing.length || unknown.length) {
		throw new Error(
			`Group ids must appear exactly once.${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}${duplicates.length ? ` Repeated: ${duplicates.join(", ")}.` : ""}${unknown.length ? ` Unknown: ${unknown.join(", ")}.` : ""}`
		);
	}
	return {
		commits: commits.map((commit) => ({
			subject: commit.subject.trim(),
			body: commit.body,
			files: commit.groups.flatMap((id) => byId.get(id)!.paths),
		})),
	};
}

/**
 * What went wrong, and therefore what to change before trying again. Providers report all of these
 * as prose rather than as stable codes, so the text is matched, most specific pattern first.
 */
type FailureKind =
	/** The endpoint will not enforce a schema. Ask for plain text instead. */
	| "response-format"
	/** The prompt was too large. Shrink the evidence. */
	| "input-limit"
	/** The requested output ceiling was refused. Lower it. */
	| "output-limit"
	/** The answer was cut off by the ceiling. Retry, possibly with less to say. */
	| "length"
	/** The answer arrived but was unusable. Retry with feedback. */
	| "invalid-output"
	/** Timeout, rate limit, or a broken connection. Retry unchanged. */
	| "transient"
	/** Credentials or configuration. Retrying cannot help. */
	| "fatal";

class ModelFailure extends Error {
	readonly kind: FailureKind;

	constructor(kind: FailureKind, message: string) {
		super(message);
		this.name = "ModelFailure";
		this.kind = kind;
	}
}

function errorText(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = error.cause instanceof Error ? error.cause.message : "";
	return `${error.name} ${error.message} ${cause}`;
}

export function classifyFailure(error: unknown): FailureKind {
	if (error instanceof ModelFailure) return error.kind;
	const status = (error as { statusCode?: unknown })?.statusCode;
	const text = errorText(error);

	// Checked before the input limit: "maximum tokens" alone cannot tell the two apart, and
	// shrinking the diff in answer to an output-ceiling complaint would never converge.
	if (/max[_ ]?(?:output[_ ]|completion[_ ])?tokens|max_output|completion[_ ]tokens/i.test(text)) {
		return /context|prompt|input/i.test(text) ? "input-limit" : "output-limit";
	}
	if (/context[_ ]length|context window|too many tokens|prompt is too long|reduce the length/i.test(text)) {
		return "input-limit";
	}
	if (/response[_ ]format|json[_ ]schema|structured output|schema is only supported|tool_choice/i.test(text)) {
		return "response-format";
	}
	if (status === 401 || status === 403 || /unauthorized|invalid api key|authentication|permission/i.test(text)) {
		return "fatal";
	}
	if (status === 404 || /model not found|no such model|does not exist|unknown model/i.test(text)) return "fatal";
	return "transient";
}

/**
 * Recover a JSON object from a reply that may be fenced, prefixed with prose, or followed by a
 * summary. Scanning for the first balanced object is necessary rather than taking the outermost
 * braces: prose around the answer routinely contains braces of its own.
 */
export function extractJsonObject(text: string): unknown {
	const trimmed = text
		.replace(/^\s*```(?:json)?\s*/i, "")
		.replace(/\s*```\s*$/, "")
		.trim();
	if (!trimmed) throw new ModelFailure("invalid-output", "The provider returned an empty response.");
	try {
		return JSON.parse(trimmed);
	} catch {
		// Fall through to scanning.
	}

	if (!trimmed.includes("{")) throw new ModelFailure("invalid-output", "The response contained no JSON object.");

	// Every `{` is a candidate, because prose around the answer routinely contains balanced braces
	// of its own. A candidate that does not parse is discarded and the next one is tried.
	let closed = false;
	for (let start = trimmed.indexOf("{"); start !== -1; start = trimmed.indexOf("{", start + 1)) {
		const end = balancedEnd(trimmed, start);
		if (end === -1) continue;
		closed = true;
		try {
			return JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			// Prose, not the plan. Keep looking.
		}
	}
	throw new ModelFailure(
		"invalid-output",
		closed ? "The response was not valid JSON." : "The response held an unterminated JSON object."
	);
}

/** Index of the `}` closing the object that opens at `start`, or -1 if it never closes. */
function balancedEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const character = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') inString = true;
		else if (character === "{") depth++;
		else if (character === "}" && --depth === 0) return index;
	}
	return -1;
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

async function callModel(input: {
	profile: Profile;
	prompt: string;
	structured: boolean;
	schema: typeof commitPlanSchema;
	maxOutputTokens: number;
	timeoutMs: number;
}): Promise<unknown> {
	const request = {
		model: modelFor(input.profile),
		prompt: input.prompt,
		maxOutputTokens: input.maxOutputTokens,
		abortSignal: AbortSignal.timeout(input.timeoutMs),
		// This function is one attempt of an outer state machine that already knows how to change
		// the request between tries. The SDK's own blind retries would only multiply the wait.
		maxRetries: 0,
	};

	if (!input.structured) {
		const { text, finishReason } = await generateText(request);
		if (finishReason === "length" && !text.trim()) {
			throw new ModelFailure("length", "The model used the whole output budget without answering.");
		}
		return extractJsonObject(text);
	}

	try {
		const result = await generateText({ ...request, output: Output.object({ schema: input.schema }) });
		if (result.finishReason === "length") {
			throw new ModelFailure("length", "The model used the whole output budget without answering.");
		}
		return result.output;
	} catch (error) {
		// The SDK already holds the text it could not coerce. Salvaging it here turns a wasted
		// round trip into a usable answer, which matters most on the slow reasoning models.
		if (NoObjectGeneratedError.isInstance(error) && error.text?.trim()) return extractJsonObject(error.text);
		throw error;
	}
}

function fallbackPlan(paths: string[], notice: string, failureReason: string): CommitPlan {
	return { ...buildFallbackPlan(paths), notice, fallback: true, ...(failureReason ? { failureReason } : {}) };
}

function clampFeedback(message: string): string {
	return message.length > MAX_FEEDBACK_BYTES ? `${message.slice(0, MAX_FEEDBACK_BYTES)}...` : message;
}

export async function generateCommitPlan(input: {
	profile: Profile;
	files: StagedFile[];
	paths: string[];
	renames: Array<[string, string]>;
	history: string[];
	context: RepositoryContext;
	split: boolean;
	body: BodyMode;
	instructions?: string;
	exclude?: string[];
	include?: string[];
	generate?: (prompt: string, structured: boolean) => Promise<unknown>;
}): Promise<CommitPlan> {
	const deadline = Date.now() + TOTAL_DEADLINE_MS;
	let budgetTokens = input.profile.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
	let outputTokens = input.profile.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
	let structured = true;
	let calls = 0;
	let contentFailures = 0;
	let validationError: string | undefined;
	let notice = "";
	let failureReason = "";

	while (calls < MAX_NETWORK_CALLS) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			failureReason ||= "the provider ran out of time";
			break;
		}
		const byteBudget = budgetTokens * BYTES_PER_TOKEN;
		// Only the plan text competes with the path echo. The rest of the ceiling is left to
		// reasoning tokens, which no provider reports in advance and none of them charge for here.
		const echoBudget = Math.max(512, Math.floor(outputTokens / ECHO_SHARE));

		// The path echo, not the prompt, is the binding constraint: the model cannot list thousands
		// of paths within the output budget. Fall back to naming pre-computed groups instead.
		const echoBytes = input.paths.reduce((total, file) => total + file.length + 6, 0);
		const groups = echoBytes / BYTES_PER_TOKEN + 512 > echoBudget ? buildGroups(input.paths) : undefined;
		const manifestBytes = groups ? groups.length * 64 : echoBytes;

		const documentBudget = Math.floor(byteBudget * 0.25);
		const evidence = buildEvidence(input.files, {
			byteBudget: Math.max(1_024, byteBudget - documentBudget - manifestBytes - SCAFFOLDING_BYTES),
			...(groups ? { groups } : {}),
			...(input.exclude ? { exclude: input.exclude } : {}),
			...(input.include ? { include: input.include } : {}),
		});
		notice = evidence.summary;

		const prompt = buildPrompt({
			evidence: evidence.block,
			files: input.paths,
			history: input.history,
			context: input.context,
			split: input.split,
			body: input.body,
			renames: input.renames,
			documentBudget,
			...(groups ? { groups } : {}),
			...(input.instructions ? { instructions: input.instructions } : {}),
			...(validationError ? { validationError } : {}),
		});

		const schema = groups ? groupPlanSchema : commitPlanSchema;
		const generate =
			input.generate ??
			((text: string, wantsStructured: boolean) =>
				callModel({
					profile: input.profile,
					prompt: text,
					structured: wantsStructured,
					schema,
					maxOutputTokens: outputTokens,
					timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remainingMs),
				}));

		calls++;
		let output: unknown;
		try {
			output = await generate(prompt, structured);
		} catch (error) {
			const kind = classifyFailure(error);
			failureReason = clampFeedback(error instanceof Error ? error.message : String(error));

			// Credentials and model names cannot be fixed by trying again, and a local `chore:`
			// message would hide a problem the user has to solve anyway.
			if (kind === "fatal") throw error;

			// Only a refusal to enforce a schema is evidence about schema support. A timeout or a
			// rate limit says nothing, so those must not cost the structured path.
			if (kind === "response-format" && structured) {
				structured = false;
				continue;
			}
			if (kind === "input-limit" && budgetTokens > MIN_INPUT_TOKENS) {
				budgetTokens = Math.max(MIN_INPUT_TOKENS, Math.floor(budgetTokens / 2));
				validationError = undefined;
				continue;
			}
			if (kind === "output-limit" && outputTokens > MIN_OUTPUT_TOKENS) {
				outputTokens = Math.max(MIN_OUTPUT_TOKENS, Math.floor(outputTokens / 2));
				validationError = undefined;
				continue;
			}
			if (kind === "length" || kind === "invalid-output") {
				if (++contentFailures > MAX_CONTENT_FAILURES) break;
				validationError = clampFeedback(error instanceof Error ? error.message : String(error));
				continue;
			}
			// Transient: the request was fine, so repeat it unchanged while time remains.
			continue;
		}

		try {
			const plan = groups
				? validateGroupPlan(output, groups, input.split)
				: validatePlan(output, input.paths, input.renames, input.split);
			// Asking for empty bodies saves output tokens. Clearing them here is what makes the
			// setting true regardless of what the model actually returned.
			if (input.body === "manual") for (const commit of plan.commits) commit.body = "";
			return { ...plan, notice };
		} catch (error) {
			failureReason = clampFeedback(error instanceof Error ? error.message : String(error));
			if (++contentFailures > MAX_CONTENT_FAILURES) break;
			validationError = failureReason;
		}
	}

	// Never leave the user without a plan: a locally built message is editable, an error is not.
	return fallbackPlan(input.paths, notice, failureReason);
}
