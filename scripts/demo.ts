/**
 * Exercise the real gc pipeline against checked-in fixtures, using the real profile from the user's
 * machine, without ever creating a commit. Development only: it is not published, since `files` in
 * package.json ships `dist` alone.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { generateCommitBody, generateCommitPlan, type CommitPlan, type PlanEvent } from "../src/ai.ts";
import { BODY_MODES, mergeConfig, readConfig, readProjectConfig, type BodyMode, type Profile } from "../src/config.ts";
import { discoverContext } from "../src/context.ts";
import { parseRepository } from "../src/git.ts";
import { reviewCommits } from "../src/review.ts";
import { createSpinner, createTerminal } from "../src/terminal.ts";

const FIXTURES = new URL("../test/fixtures/staged/", import.meta.url);

const { values } = parseArgs({
	options: {
		fixture: { type: "string", default: "mixed" },
		offline: { type: "boolean", default: false },
		slow: { type: "boolean", default: false },
		split: { type: "boolean" },
		body: { type: "string" },
	},
});

if (values.body !== undefined && !BODY_MODES.some((mode) => mode === values.body)) {
	throw new Error(`--body must be one of: ${BODY_MODES.join(", ")}.`);
}

const name = values.fixture;
const [diff, names, historyJson, planJson] = await Promise.all([
	readFile(new URL(`${name}.diff`, FIXTURES)),
	readFile(new URL(`${name}.names`, FIXTURES)),
	readFile(new URL("history.json", FIXTURES), "utf8"),
	readFile(new URL(`${name}.plan.json`, FIXTURES), "utf8"),
]);

const repository = parseRepository(diff, names, JSON.parse(historyJson) as string[]);
const canned = JSON.parse(planJson) as CommitPlan;
const root = process.cwd();
const context = await discoverContext(root, repository.paths);

// Mirrors src/cli.ts: project settings (.gc.yaml) override the user config, CLI flags override both.
// A minimal stand-in config is used when no user config exists, since offline mode must not require one.
const config = await readConfig();
const merged = mergeConfig(config ?? { activeProfile: "", split: true, profiles: {} }, await readProjectConfig(root));
const split = values.split ?? merged.split;
const body: BodyMode = (values.body as BodyMode | undefined) ?? merged.body;

/** Type the canned subjects out so the streaming display has something to show. */
async function replay(onProgress?: (event: PlanEvent) => void) {
	onProgress?.({ type: "phase", label: "writing plan" });
	if (!values.slow) return canned;
	for (const [index, commit] of canned.commits.entries()) {
		for (let cut = 1; cut <= commit.subject.length; cut++) {
			onProgress?.({ type: "subject", index, text: commit.subject.slice(0, cut) });
			await new Promise((resolve) => setTimeout(resolve, 12));
		}
	}
	return canned;
}

let profileLabel = "offline";
let generate: Parameters<typeof generateCommitPlan>[0]["generate"];
let liveProfile: Profile | undefined;

if (values.offline) {
	generate = (_prompt, _structured, onProgress) => replay(onProgress);
} else {
	if (!config) throw new Error("No configuration found. Run gc init first, or use --offline.");
	const profile = config.profiles[config.activeProfile];
	if (!profile) throw new Error(`Active profile does not exist: ${config.activeProfile}`);
	profileLabel = profile.model;
	liveProfile = profile;
}

const terminal = createTerminal();
const spinner = createSpinner(terminal, profileLabel);
spinner.phase("waiting for the model");

let plan: CommitPlan;
try {
	plan = await generateCommitPlan({
		profile: values.offline
			? { provider: "openai", baseUrl: "https://example.invalid/v1", model: "offline", apiKey: "" }
			: (liveProfile as Profile),
		files: repository.files,
		paths: repository.paths,
		renames: repository.renames.map(({ from, to }) => [from, to]),
		history: repository.history,
		context,
		split,
		body,
		onProgress: (event) => {
			if (event.type === "phase") spinner.phase(event.label);
			if (event.type === "subject") spinner.subject(event.index, event.text);
			if (event.type === "retry") spinner.note(`retry ${event.attempt}: ${event.reason}`);
		},
		...(generate ? { generate } : {}),
	});
} finally {
	spinner.stop();
}

const { outcome, commits } = await reviewCommits({
	plan,
	onGenerate: values.offline
		? async (_index, _subject, signal) => {
				// Slow on purpose, so the row spinner and esc can both be exercised by hand.
				await new Promise((resolve, reject) => {
					const timer = setTimeout(resolve, 2_000);
					signal.addEventListener("abort", () => {
						clearTimeout(timer);
						reject(signal.reason as Error);
					});
				});
				return "A canned body, written slowly so the row spinner and esc can be exercised.";
			}
		: (_index, subject, signal) =>
				generateCommitBody({ profile: liveProfile as Profile, subject, files: repository.files, context, signal }),
});
if (outcome !== "commit") {
	process.stdout.write(`${outcome}\n`);
} else {
	for (const commit of commits) {
		const commitBody = commit.body.trim() ? ` -m ${JSON.stringify(commit.body)}` : "";
		process.stdout.write(`would run: git commit -m ${JSON.stringify(commit.subject)}${commitBody}\n`);
	}
}
