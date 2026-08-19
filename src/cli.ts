import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { emitKeypressEvents, type Interface } from "node:readline";
import { parseArgs } from "node:util";

import { ExternalEditor } from "@inquirer/external-editor";

import packageJson from "../package.json" with { type: "json" };
import { createBodyGenerator, DEFAULT_MAX_INPUT_TOKENS, generateCommitPlan, type CommitPlan } from "./ai.ts";
import {
	BODY_MODES,
	getConfigPath,
	mergeConfig,
	readConfig,
	readProjectConfig,
	runInit,
	runProfile,
	runSetup,
	type BodyMode,
} from "./config.ts";
import { discoverContext } from "./context.ts";
import { createCommits, pushCommits, readRepository } from "./git.ts";
import { reviewCommits } from "./review.ts";
import { createSpinner, createTerminal } from "./terminal.ts";

export const help = `Usage:
  gc [-a|--all] [-i|--instructions <text>] [--split|--no-split] [--body <mode>]
  gc init
  gc setup
  gc config
  gc profile [name]
  gc --help
  gc --version`;

export type CliArguments =
	| { command: "help"; all: false }
	| { command: "version"; all: false }
	| { command: "init"; all: false }
	| { command: "setup"; all: false }
	| { command: "config"; all: false }
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
	if (
		extra.length ||
		(command && !["init", "setup", "config", "profile"].includes(command)) ||
		(command !== "profile" && name)
	) {
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
		if (command === "init" || command === "setup" || command === "config") return { command, all: false };
		return { command: "profile", ...(name ? { name } : {}), all: false };
	}
	return {
		command: "commit",
		all: parsed.values.all,
		...(parsed.values.instructions ? { instructions: parsed.values.instructions } : {}),
		...(parsed.values.split ? { split: true } : parsed.values["no-split"] ? { split: false } : {}),
		...(body !== undefined ? { body: body as BodyMode } : {}),
	};
}

export function openConfig(
	path = getConfigPath(),
	editor: { bin: string; args: string[] } = new ExternalEditor().editor
) {
	if (!existsSync(path)) throw new Error("No configuration found. Run gc init first.");
	const result = spawnSync(editor.bin, [...editor.args, path], { stdio: "inherit" });
	if (result.error) throw new Error(`Editor failed: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`Editor exited with status ${result.status ?? "unknown"}.`);
}

export async function run(args = process.argv.slice(2)): Promise<void> {
	const options = parseCliArgs(args);
	if (options.command === "help") return void process.stdout.write(`${help}\n`);
	if (options.command === "version") return void process.stdout.write(`${packageJson.version}\n`);
	if (options.command === "config") return openConfig();
	if (options.command === "init") {
		const config = await runInit();
		return void process.stdout.write(config ? "Configuration saved.\n" : "Configuration unchanged.\n");
	}
	if (options.command === "setup") {
		await runSetup();
		return void process.stdout.write("Configuration saved.\n");
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
	const renames: Array<[string, string]> = repository.renames.map(({ from, to }) => [from, to]);

	// A lone escape is also the first byte of every arrow key, so readline holds it back until it
	// knows which one it is: half a second by default, and @inquirer/core builds its interface
	// without the option that shortens it. The wait is per stream and fixed when the decoder is
	// installed, so stdin is armed here instead, and the interface the review creates later finds
	// the stream already decoding and leaves it alone. 50ms still covers a terminal that splits a
	// sequence across two reads, and is short enough to read as instant.
	emitKeypressEvents(process.stdin, { escapeCodeTimeout: 50 } as unknown as Interface);

	for (;;) {
		// A reasoning model can think for a minute before its first token. Without a spinner the
		// CLI looks hung, and the user kills a request that was about to succeed.
		const spinner = createSpinner(terminal, "Generating commit(s)");
		spinner.phase("building context");

		let plan: CommitPlan;
		try {
			plan = await generateCommitPlan({
				profile,
				files: repository.files,
				paths: repository.paths,
				renames,
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
		const { outcome, commits } = await reviewCommits({
			plan,
			onGenerate: createBodyGenerator({
				profile,
				plan,
				files: repository.files,
				renames,
				context,
				...(options.instructions ? { instructions: options.instructions } : {}),
			}),
		});
		if (outcome === "regenerate") continue;
		if (outcome === "cancel") return void process.stdout.write("Cancelled.\n");
		await createCommits(repository.root, commits);
		if (outcome === "push") await pushCommits(repository.root);
		return;
	}
}
