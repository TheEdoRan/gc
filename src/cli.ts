import { parseArgs } from "node:util";

import { editor, select } from "@inquirer/prompts";

import packageJson from "../package.json" with { type: "json" };
import { generateCommitPlan, type CommitPlan } from "./ai.ts";
import { readConfig, runInit, runProfile } from "./config.ts";
import { discoverContext } from "./context.ts";
import { createCommits, readRepository } from "./git.ts";

export const help = `Usage:
  gc [-a|--all] [-i|--instructions <text>] [--split|--no-split]
  gc init
  gc profile [name]
  gc --help
  gc --version`;

export type CliArguments =
	| { command: "help"; all: false }
	| { command: "version"; all: false }
	| { command: "init"; all: false }
	| { command: "profile"; name?: string; all: false }
	| { command: "commit"; all: boolean; instructions?: string; split?: boolean };

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
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
	});
	if (parsed.values.split && parsed.values["no-split"])
		throw new Error("--split and --no-split cannot be used together.");
	if (parsed.values.help) return { command: "help", all: false };
	if (parsed.values.version) return { command: "version", all: false };

	const [command, name, ...extra] = parsed.positionals;
	if (extra.length || (command && !["init", "profile"].includes(command)) || (command === "init" && name)) {
		throw new Error(`Invalid command.\n\n${help}`);
	}
	if (command) {
		if (parsed.values.all || parsed.values.instructions || parsed.values.split || parsed.values["no-split"]) {
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
	};
}

export function formatPlan(plan: CommitPlan): string {
	return plan.commits
		.map(
			(commit, index) =>
				`\n${index + 1}. ${commit.subject}${commit.body ? `\n\n${commit.body}` : ""}\n\n${commit.files.map((file) => `   ${file}`).join("\n")}`
		)
		.join("\n");
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
	const repository = await readRepository(process.cwd(), options.all);
	if (!repository.paths.length) throw new Error("No staged changes.");
	const context = await discoverContext(repository.root, repository.paths);
	const split = options.split ?? config.split;

	for (;;) {
		const plan = await generateCommitPlan({
			profile,
			diff: repository.diff,
			files: repository.paths,
			renames: repository.renames.map(({ from, to }) => [from, to]),
			history: repository.history,
			context,
			split,
			...(options.instructions ? { instructions: options.instructions } : {}),
		});
		const action = await reviewPlan(plan);
		if (action === "regenerate") continue;
		if (action === "cancel") return void process.stdout.write("Cancelled.\n");
		await createCommits(repository.root, plan.commits);
		return;
	}
}
