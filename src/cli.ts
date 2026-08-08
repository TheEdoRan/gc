import { parseArgs } from "node:util";

import { editor, select } from "@inquirer/prompts";

import packageJson from "../package.json" with { type: "json" };
import { DEFAULT_MAX_INPUT_TOKENS, generateCommitPlan, type CommitPlan } from "./ai.ts";
import {
	BODY_MODES,
	mergeConfig,
	readConfig,
	readProjectConfig,
	runInit,
	runProfile,
	type BodyMode,
} from "./config.ts";
import { discoverContext } from "./context.ts";
import { createCommits, readRepository } from "./git.ts";
import { createSpinner, createTerminal } from "./terminal.ts";

export const help = `Usage:
  gc [-a|--all] [-i|--instructions <text>] [--split|--no-split] [--body <mode>]
  gc init
  gc profile [name]
  gc --help
  gc --version`;

export type CliArguments =
	| { command: "help"; all: false }
	| { command: "version"; all: false }
	| { command: "init"; all: false }
	| { command: "profile"; name?: string; all: false }
	| { command: "commit"; all: boolean; instructions?: string; split?: boolean; body?: BodyMode };

export function parseCliArgs(args: string[]): CliArguments {
	const parsed = parseArgs({
		args,
		allowPositionals: true,
		strict: true,
		options: {
			all: { type: "boolean", short: "a", default: false },
			instructions: { type: "string", short: "i" },
			split: { type: "boolean" },
			"no-split": { type: "boolean" },
			body: { type: "string" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
	});
	if (parsed.values.split && parsed.values["no-split"])
		throw new Error("--split and --no-split cannot be used together.");
	const body = parsed.values.body;
	if (body !== undefined && !BODY_MODES.some((mode) => mode === body)) {
		throw new Error(`--body must be one of: ${BODY_MODES.join(", ")}.`);
	}
	if (parsed.values.help) return { command: "help", all: false };
	if (parsed.values.version) return { command: "version", all: false };

	const [command, name, ...extra] = parsed.positionals;
	if (extra.length || (command && !["init", "profile"].includes(command)) || (command === "init" && name)) {
		throw new Error(`Invalid command.\n\n${help}`);
	}
	if (command) {
		if (
			parsed.values.all ||
			parsed.values.instructions ||
			parsed.values.split ||
			parsed.values["no-split"] ||
			body !== undefined
		) {
			throw new Error(`Commit options cannot be used with gc ${command}.`);
		}
		return command === "init"
			? { command: "init", all: false }
			: { command: "profile", ...(name ? { name } : {}), all: false };
	}
	return {
		command: "commit",
		all: parsed.values.all,
		...(parsed.values.instructions ? { instructions: parsed.values.instructions } : {}),
		...(parsed.values.split ? { split: true } : parsed.values["no-split"] ? { split: false } : {}),
		...(body !== undefined ? { body: body as BodyMode } : {}),
	};
}

export function formatPlan(plan: CommitPlan): string {
	const commits = plan.commits
		.map(
			(commit, index) =>
				`\n${index + 1}. ${commit.subject}${commit.body ? `\n\n${commit.body}` : ""}\n\n${commit.files.map((file) => `   ${file}`).join("\n")}`
		)
		.join("\n");
	const banner = plan.fallback
		? `\n! the provider did not return a plan, showing a local fallback you can edit${plan.failureReason ? `\n! ${plan.failureReason}` : ""}\n`
		: "";
	const notice = plan.notice ? `\n\ncontext: ${plan.notice}` : "";
	return `${banner}${commits}${notice}`;
}

export interface ReviewPrompts {
	select<T>(options: { message: string; choices: Array<{ name: string; value: T }> }): Promise<T>;
	editor(options: { message: string; default?: string }): Promise<string>;
}

const reviewPrompts: ReviewPrompts = {
	select: (options) => select(options),
	editor: (options) => editor(options),
};

export async function reviewPlan(
	plan: CommitPlan,
	prompts = reviewPrompts
): Promise<"commit" | "regenerate" | "cancel"> {
	for (;;) {
		process.stdout.write(`${formatPlan(plan)}\n\n`);
		const action = await prompts.select({
			message: "Review commit plan",
			choices: [
				{ name: "Commit plan", value: "commit" as const },
				{ name: "Edit one message", value: "edit" as const },
				{ name: "Regenerate", value: "regenerate" as const },
				{ name: "Cancel", value: "cancel" as const },
			],
		});
		if (action !== "edit") return action;
		const index = await prompts.select({
			message: "Message to edit",
			choices: plan.commits.map((commit, commitIndex) => ({ name: commit.subject, value: commitIndex })),
		});
		const commit = plan.commits[index];
		if (!commit) continue;
		const message = (
			await prompts.editor({
				message: "Edit commit message",
				default: `${commit.subject}${commit.body ? `\n\n${commit.body}` : ""}`,
			})
		).replace(/\r\n/g, "\n");
		const [subject = "", ...body] = message.split("\n");
		if (!subject.trim()) throw new Error("A commit subject cannot be empty.");
		commit.subject = subject.trim();
		commit.body = body.join("\n").trim();
	}
}

export async function run(args = process.argv.slice(2)): Promise<void> {
	const options = parseCliArgs(args);
	if (options.command === "help") return void process.stdout.write(`${help}\n`);
	if (options.command === "version") return void process.stdout.write(`${packageJson.version}\n`);
	if (options.command === "init") {
		await runInit();
		return void process.stdout.write("Profile saved.\n");
	}
	if (options.command === "profile") {
		const config = await runProfile(options.name);
		return void process.stdout.write(`Active profile: ${config.activeProfile}\n`);
	}

	const config = await readConfig();
	if (!config) throw new Error("No configuration found. Run gc init first.");
	const profile = config.profiles[config.activeProfile];
	if (!profile) throw new Error(`Active profile does not exist: ${config.activeProfile}`);

	// Retain a few multiples of the prompt budget while streaming so reallocation has slack, but
	// stay bounded no matter how large the staged diff is.
	const retainBudget = (profile.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS) * 2 * 4;

	const terminal = createTerminal();
	const boot = createSpinner(terminal, profile.model);
	boot.phase("reading staged changes");
	// Stopped on failure too, so a thrown error never leaves the cursor hidden.
	const repository = await readRepository(process.cwd(), options.all, retainBudget).finally(() => boot.stop());
	if (!repository.paths.length) throw new Error("No staged changes.");

	const merged = mergeConfig(config, await readProjectConfig(repository.root));
	boot.phase("reading project context");
	const context = await discoverContext(repository.root, repository.paths).finally(() => boot.stop());
	const split = options.split ?? merged.split;

	for (;;) {
		// A reasoning model can think for a minute before its first token. Without a spinner the
		// CLI looks hung, and the user kills a request that was about to succeed.
		const spinner = createSpinner(terminal, profile.model);
		spinner.phase("building context");

		let plan: CommitPlan;
		try {
			plan = await generateCommitPlan({
				profile,
				files: repository.files,
				paths: repository.paths,
				renames: repository.renames.map(({ from, to }) => [from, to]),
				history: repository.history,
				context,
				split,
				body: options.body ?? merged.body,
				exclude: merged.excludeContent,
				include: merged.includeContent,
				onProgress: (event) => {
					if (event.type === "phase") spinner.phase(event.label);
					if (event.type === "subject") spinner.subject(event.index, event.text);
					if (event.type === "retry") spinner.note(`retry ${event.attempt}: ${event.reason}`);
				},
				...(options.instructions ? { instructions: options.instructions } : {}),
			});
		} finally {
			spinner.stop();
		}
		const action = await reviewPlan(plan);
		if (action === "regenerate") continue;
		if (action === "cancel") return void process.stdout.write("Cancelled.\n");
		await createCommits(repository.root, plan.commits);
		return;
	}
}
