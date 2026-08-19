import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

import {
	getConfigPath,
	initConfig,
	mergeConfig,
	profilePrompt,
	readConfig,
	readProjectConfig,
	selectProfile,
	setupConfig,
	setupPrompt,
	setupProfile,
	validateConfig,
	validateProjectConfig,
	writeConfig,
	type Config,
	type ConfigPrompts,
} from "../src/config.ts";
import { PROVIDER_PRESETS, type ModelPrompts } from "../src/providers.ts";

const config: Config = {
	activeProfile: "personal",
	split: true,
	profiles: {
		personal: {
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			model: "gpt-test",
			apiKey: "secret",
		},
	},
};

async function driveProfilePrompt(profiles: string[], activeProfile: string, ...keys: string[]) {
	const input = new PassThrough();
	const output = new PassThrough();
	let drawn = "";
	output.on("data", (data: Buffer) => {
		drawn += data.toString();
	});
	const result = profilePrompt({ profiles, activeProfile }, { input, output });
	await new Promise((resolve) => setImmediate(resolve));
	for (const key of keys) {
		input.write(key === "down" ? "\u001b[B" : key === "enter" ? "\r" : key);
		await new Promise((resolve) => setImmediate(resolve));
	}
	return { result, rawText: () => drawn, text: () => stripVTControlCharacters(drawn) };
}

async function driveSetupPrompt(split: boolean, body: "manual" | "auto" | "always", ...keys: string[]) {
	const input = new PassThrough();
	const output = new PassThrough();
	let drawn = "";
	output.on("data", (data: Buffer) => {
		drawn += data.toString();
	});
	const result = setupPrompt({ split, body }, { input, output });
	await new Promise((resolve) => setImmediate(resolve));
	for (const key of keys) {
		input.write(key === "down" ? "\u001b[B" : key === "enter" ? "\r" : key === "space" ? " " : key);
		await new Promise((resolve) => setImmediate(resolve));
	}
	return { result, rawText: () => drawn, text: () => stripVTControlCharacters(drawn) };
}

void test("reads and atomically writes a strict config", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gc-config-"));
	const path = join(directory, "nested", "config.yaml");
	await writeConfig(config, path);
	assert.deepEqual(await readConfig(path), config);
	assert(!(await readFile(path, "utf8")).includes("!!"));
	if (process.platform !== "win32") {
		assert.equal((await stat(join(directory, "nested"))).mode & 0o777, 0o700);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	}
});

void test("rejects unknown fields, missing profiles, and duplicate YAML keys", async () => {
	assert.throws(() => validateConfig({ ...config, unexpected: true }), /Invalid config structure/);
	assert.throws(() => validateConfig({ ...config, split: undefined }), /Invalid split setting/);
	assert.throws(() => validateConfig({ ...config, activeProfile: "missing" }), /does not exist/);
	assert.throws(
		() =>
			validateConfig({
				...config,
				profiles: { personal: { ...config.profiles.personal, unexpected: true } },
			}),
		/Invalid profile/
	);
	assert.throws(
		() =>
			validateConfig({
				...config,
				profiles: { personal: { ...config.profiles.personal, split: true, body: "auto" } },
			}),
		/Invalid profile/
	);

	const directory = await mkdtemp(join(tmpdir(), "gc-yaml-"));
	const path = join(directory, "config.yaml");
	await writeFile(path, "activeProfile: one\nactiveProfile: two\nsplit: true\nprofiles: {}\n");
	await assert.rejects(readConfig(path), /Map keys must be unique/);
});

void test("round-trips optional profile and content settings", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gc-optional-"));
	const path = join(directory, "config.yaml");
	const extended: Config = {
		...config,
		excludeContent: ["dist/**"],
		includeContent: ["pnpm-lock.yaml"],
		profiles: { personal: { ...config.profiles.personal!, maxInputTokens: 6000 } },
	};
	await writeConfig(extended, path);
	assert.deepEqual(await readConfig(path), extended);
	assert.deepEqual(validateConfig(config), config);
});

void test("rejects invalid maxInputTokens and content globs", () => {
	for (const maxInputTokens of [0, -1, 1.5, 3_000_000, "6000"]) {
		assert.throws(
			() =>
				validateConfig({
					...config,
					profiles: { personal: { ...config.profiles.personal, maxInputTokens } },
				}),
			/Invalid maxInputTokens/
		);
	}
	assert.throws(() => validateConfig({ ...config, excludeContent: "dist/**" }), /Invalid excludeContent/);
	assert.throws(() => validateConfig({ ...config, includeContent: [""] }), /Invalid includeContent/);
	assert.throws(
		() => validateConfig({ ...config, profiles: { personal: { ...config.profiles.personal, unknown: 1 } } }),
		/Invalid profile/
	);
	assert.throws(() => validateConfig({ ...config, unknown: 1 }), /Invalid config structure/);
});

void test("reads a project config and rejects credential keys", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gc-project-"));
	assert.equal(await readProjectConfig(directory), undefined);

	const path = join(directory, ".gc.yaml");
	await writeFile(path, "split: false\nexcludeContent:\n  - dist/**\n");
	assert.deepEqual(await readProjectConfig(directory), { split: false, excludeContent: ["dist/**"] });

	for (const key of ["apiKey", "profiles", "activeProfile"]) {
		assert.throws(() => validateProjectConfig({ [key]: "anything" }), /is not allowed in \.gc\.yaml/);
		assert.throws(() => validateProjectConfig({ [key]: "anything" }), new RegExp(`^Error: ${key} is not allowed`));
	}
	assert.throws(() => validateProjectConfig({ unknown: true }), /Invalid project config structure/);
	assert.throws(() => validateProjectConfig({ split: "yes" }), /Invalid split setting/);

	await writeFile(path, "split: true\nsplit: false\n");
	await assert.rejects(readProjectConfig(directory), /Map keys must be unique/);
	await writeFile(path, "excludeContent: &a\n  - dist/**\nincludeContent: *a\n");
	await assert.rejects(readProjectConfig(directory), /alias/i);
});

void test("merges project settings over the global config", () => {
	const global: Config = { ...config, excludeContent: ["dist/**"], includeContent: ["a.txt"] };
	assert.deepEqual(mergeConfig(global, { excludeContent: ["out/**"], split: false }), {
		excludeContent: ["dist/**", "out/**"],
		includeContent: ["a.txt"],
		split: false,
		body: "manual",
	});
	assert.deepEqual(mergeConfig(config), { excludeContent: [], includeContent: [], split: true, body: "manual" });
});

void test("uses the platform config directory", () => {
	assert.equal(basename(getConfigPath()), "config.yaml");
	assert.match(getConfigPath(), /gc/);
});

void test("creates a compatible profile with an empty key", async () => {
	const answers = ["work", "http://localhost:11434/v1"];
	const prompts: ConfigPrompts = {
		input: async () => answers.shift() ?? "",
		password: async () => "",
		select: async () => {
			throw new Error("Profile setup must not ask for body settings");
		},
		search: async () => "compatible",
		confirm: async () => {
			throw new Error("Profile setup must not ask for split settings");
		},
	};
	const modelPrompts: ModelPrompts = {
		input: async () => "local-model",
		search: async () => "unused",
	};
	const created = await setupProfile(undefined, undefined, {
		prompts,
		modelPrompts,
		fetcher: async () => new Response("unavailable", { status: 503 }),
	});
	assert.deepEqual(created, {
		activeProfile: "work",
		split: true,
		body: "manual",
		profiles: {
			work: { provider: "compatible", baseUrl: "http://localhost:11434/v1", model: "local-model", apiKey: "" },
		},
	});
});

void test("gc init sets the global body and split settings", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gc-init-"));
	const path = join(directory, "config.yaml");
	const prompts: ConfigPrompts = {
		input: async (options) => (options.message === "Profile name" ? "work" : "http://localhost:11434/v1"),
		password: async () => "",
		select: async () => "always",
		search: async () => "compatible",
		confirm: async () => false,
	};
	const initialized = await initConfig(undefined, {
		path,
		prompts,
		modelPrompts: { input: async () => "local-model", search: async () => "unused" },
		fetcher: async () => new Response("unavailable", { status: 503 }),
	});
	assert.ok(initialized);
	assert.equal(initialized.body, "always");
	assert.equal(initialized.split, false);
	assert.equal(Object.hasOwn(initialized.profiles.work!, "body"), false);
	assert.equal(Object.hasOwn(initialized.profiles.work!, "split"), false);
});

void test("gc init protects an existing configuration by default", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gc-init-existing-"));
	const path = join(directory, "config.yaml");
	await writeConfig(config, path);
	let confirmation: Parameters<ConfigPrompts["confirm"]>[0] | undefined;
	const skipped = await initConfig(undefined, {
		path,
		prompts: {
			input: async () => {
				throw new Error("Initialization must stop before profile setup");
			},
			password: async () => {
				throw new Error("Initialization must stop before profile setup");
			},
			select: async () => {
				throw new Error("Initialization must stop before global setup");
			},
			search: async () => {
				throw new Error("Initialization must stop before profile setup");
			},
			confirm: async (options) => {
				confirmation = options;
				return false;
			},
		},
	});
	assert.equal(skipped, undefined);
	assert.deepEqual(confirmation, { message: "Re-initialize gc config?", default: false });
	assert.deepEqual(await readConfig(path), config);
});

void test("gc init replaces an existing configuration after confirmation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gc-reinit-"));
	const path = join(directory, "config.yaml");
	await writeConfig(config, path);
	const replaced = await initConfig(undefined, {
		path,
		prompts: {
			input: async (options) => (options.message === "Profile name" ? "work" : "http://localhost:11434/v1"),
			password: async () => "",
			select: async () => "auto",
			search: async () => "compatible",
			confirm: async (options) => options.message.startsWith("Re-initialize"),
		},
		modelPrompts: { input: async () => "local", search: async () => "unused" },
		fetcher: async () => new Response("unavailable", { status: 503 }),
	});
	assert.deepEqual(Object.keys(replaced?.profiles ?? {}), ["work"]);
	assert.equal(replaced?.activeProfile, "work");
});

void test("gc setup saves global settings", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gc-setup-"));
	const path = join(directory, "config.yaml");
	await writeConfig(config, path);
	const updated = await setupConfig({
		path,
		setupPrompt: async () => ({ split: false, body: "always" }),
	});
	assert.equal(updated.split, false);
	assert.equal(updated.body, "always");
});

void test("setup prompt toggles splitting and cycles body mode with space", { timeout: 5000 }, async () => {
	const previousForceColor = process.env.FORCE_COLOR;
	const previousNoColor = process.env.NO_COLOR;
	delete process.env.NO_COLOR;
	process.env.FORCE_COLOR = "1";
	let highlighted: Awaited<ReturnType<typeof driveSetupPrompt>>;
	try {
		highlighted = await driveSetupPrompt(true, "manual", "q");
	} finally {
		if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
		else process.env.FORCE_COLOR = previousForceColor;
		if (previousNoColor === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = previousNoColor;
	}
	assert.match(highlighted.rawText(), /\u001b\[36m\u276f Commit splitting:/);
	assert.match(highlighted.rawText(), /\u001b\[36mon\u001b\[36m/);
	assert.match(highlighted.rawText(), /\u001b\[2moff\u001b\[22m/);
	assert.match(highlighted.rawText(), /\u001b\[36mmanual\u001b\[39m/);
	assert.match(highlighted.text(), /Commit splitting: on off/);
	assert.match(highlighted.text(), /Commit body: manual auto always/);
	assert.doesNotMatch(highlighted.text(), /Profile manager/);
	assert.doesNotMatch(highlighted.text(), /\u21b5 open/);

	const saved = await driveSetupPrompt(true, "manual", "space", "down", "space", "space", "q");
	assert.deepEqual(await saved.result, { split: false, body: "always" });
	assert.match(saved.text(), /Commit splitting: on off/);
	assert.match(saved.text(), /Commit body: manual auto always/);
});

void test("updates a profile without exposing or replacing its stored key when the provider changes", async () => {
	const prompts: ConfigPrompts = {
		input: async () => "https://proxy.example/v1/",
		password: async () => "",
		select: async () => {
			throw new Error("Profile editing must not ask for body settings");
		},
		search: async () => "deepseek",
		confirm: async () => {
			throw new Error("Profile editing must not ask for split settings");
		},
	};
	const modelPrompts: ModelPrompts = {
		input: async () => "gpt-new",
		search: async () => "unused",
	};
	const updated = await setupProfile(config, "personal", {
		prompts,
		modelPrompts,
		fetcher: async () => new Response("unavailable", { status: 503 }),
	});
	assert.equal(updated.profiles.personal?.apiKey, "secret");
	assert.equal(updated.profiles.personal?.provider, "deepseek");
	assert.equal(updated.profiles.personal?.model, "gpt-new");
	assert.equal(updated.profiles.personal?.baseUrl, "https://proxy.example/v1");
});

void test("searches providers and uses a preset URL as an editable default", async () => {
	let offered: Array<{ name: string; value: string }> = [];
	const created = await setupProfile(undefined, undefined, {
		prompts: {
			input: async (options) => (options.message === "Profile name" ? "work" : (options.default ?? "")),
			password: async () => "secret",
			select: async () => {
				throw new Error("Profile setup must not ask for body settings");
			},
			search: async (options) => {
				offered = await options.source("gro");
				return offered[0]?.value ?? "";
			},
			confirm: async () => {
				throw new Error("Profile setup must not ask for split settings");
			},
		},
		modelPrompts: { input: async () => "llama", search: async () => "unused" },
		fetcher: async () => new Response("unavailable", { status: 503 }),
	});
	assert.deepEqual(offered, [{ name: "Groq", value: "groq" }]);
	assert.equal(created.profiles.work?.baseUrl, "https://api.groq.com/openai/v1");
});

void test("accepts every provider and requires keys only for remote presets", () => {
	for (const [provider, preset] of Object.entries(PROVIDER_PRESETS)) {
		const baseUrl = preset.baseUrl || "http://localhost:8080/v1";
		const candidate = {
			...config,
			profiles: {
				personal: { provider, baseUrl, model: "model", apiKey: preset.requiresApiKey ? "key" : "" },
			},
		};
		assert.equal(validateConfig(candidate).profiles.personal?.provider, provider);
		if (preset.requiresApiKey) {
			assert.throws(
				() => validateConfig({ ...candidate, profiles: { personal: { ...candidate.profiles.personal, apiKey: "" } } }),
				/Invalid apiKey/
			);
		}
	}
	assert.throws(
		() =>
			validateConfig({
				...config,
				profiles: { personal: { ...config.profiles.personal, provider: "unknown" } },
			}),
		/Invalid provider/
	);
});

void test("switches profiles directly and starts interactive selection on the active profile", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gc-switch-"));
	const path = join(directory, "config.yaml");
	await writeConfig(
		{
			...config,
			profiles: {
				...config.profiles,
				work: {
					provider: "compatible",
					baseUrl: "http://localhost:11434/v1",
					model: "local",
					apiKey: "",
				},
			},
		},
		path
	);
	assert.equal((await selectProfile("work", { path })).activeProfile, "work");
	assert.equal((await readConfig(path))?.activeProfile, "work");
	let selection: { profiles: string[]; activeProfile: string } | undefined;
	await selectProfile(undefined, {
		path,
		profilePrompt: async (options) => {
			selection = options;
			return { action: "select", name: options.activeProfile };
		},
	});
	assert.deepEqual(selection, { profiles: ["work", "personal"], activeProfile: "work" });
});

void test("edits and deletes profiles without changing the active profile unexpectedly", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gc-manage-"));
	const path = join(directory, "config.yaml");
	await writeConfig(
		{
			...config,
			profiles: {
				...config.profiles,
				work: {
					provider: "compatible",
					baseUrl: "http://localhost:11434/v1",
					model: "old",
					apiKey: "",
				},
			},
		},
		path
	);
	const prompts: ConfigPrompts = {
		input: async () => "http://localhost:11434/v1",
		password: async () => "",
		select: async () => {
			throw new Error("Profile editing must not ask for body settings");
		},
		search: async () => "compatible",
		confirm: async (options) => {
			if (options.message.startsWith("Delete")) return true;
			throw new Error("Profile editing must not ask for split settings");
		},
	};
	await selectProfile(undefined, {
		path,
		prompts,
		profilePrompt: async () => ({ action: "edit", name: "work" }),
		modelPrompts: { input: async () => "new", search: async () => "unused" },
		fetcher: async () => new Response("unavailable", { status: 503 }),
	});
	assert.equal((await readConfig(path))?.activeProfile, "personal");
	assert.equal((await readConfig(path))?.profiles.work?.model, "new");

	await selectProfile(undefined, {
		path,
		prompts,
		profilePrompt: async () => ({ action: "delete", name: "personal" }),
	});
	assert.deepEqual(await readConfig(path), {
		activeProfile: "work",
		split: true,
		body: "manual",
		profiles: {
			work: { provider: "compatible", baseUrl: "http://localhost:11434/v1", model: "new", apiKey: "" },
		},
	});
});

void test("adds and activates a profile from profile management", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gc-add-profile-"));
	const path = join(directory, "config.yaml");
	await writeConfig(config, path);
	const updated = await selectProfile(undefined, {
		path,
		profilePrompt: async () => ({ action: "add" }),
		prompts: {
			input: async (options) => (options.message === "Profile name" ? "work" : "http://localhost:11434/v1"),
			password: async () => "",
			select: async () => {
				throw new Error("Profile setup must not ask for body settings");
			},
			search: async () => "compatible",
			confirm: async () => {
				throw new Error("Profile setup must not ask for split settings");
			},
		},
		modelPrompts: { input: async () => "local", search: async () => "unused" },
		fetcher: async () => new Response("unavailable", { status: 503 }),
	});
	assert.equal(updated.activeProfile, "work");
	assert.deepEqual(Object.keys(updated.profiles), ["personal", "work"]);
});

void test("profile prompt binds a, e, and d and protects the only profile", { timeout: 5000 }, async () => {
	const previousForceColor = process.env.FORCE_COLOR;
	const previousNoColor = process.env.NO_COLOR;
	delete process.env.NO_COLOR;
	process.env.FORCE_COLOR = "1";
	let colored: Awaited<ReturnType<typeof driveProfilePrompt>>;
	try {
		colored = await driveProfilePrompt(["personal", "work"], "personal", "enter");
	} finally {
		if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
		else process.env.FORCE_COLOR = previousForceColor;
		if (previousNoColor === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = previousNoColor;
	}
	assert.match(colored.rawText(), /\u001b\[36m\u276f personal/);
	assert.match(colored.text(), /\? Profile list/);
	assert.match(colored.text(), /\u21b5 make active/);

	const edit = await driveProfilePrompt(["personal", "work"], "personal", "down", "e");
	assert.deepEqual(await edit.result, { action: "edit", name: "work" });
	const add = await driveProfilePrompt(["personal", "work"], "personal", "a");
	assert.deepEqual(await add.result, { action: "add" });
	const remove = await driveProfilePrompt(["personal", "work"], "personal", "d");
	assert.deepEqual(await remove.result, { action: "delete", name: "personal" });
	const only = await driveProfilePrompt(["personal"], "personal", "d", "enter");
	assert.match(only.text(), /The only profile cannot be deleted\./);
	assert.deepEqual(await only.result, { action: "select", name: "personal" });
});

void test("body defaults to manual and rejects unknown values", async () => {
	const parsed = validateConfig({
		activeProfile: "personal",
		split: true,
		profiles: {
			personal: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5", apiKey: "k" },
		},
	});
	assert.equal(parsed.body, undefined);
	assert.equal(mergeConfig(parsed).body, "manual");

	assert.equal(validateConfig({ ...parsed, body: "always" }).body, "always");
	assert.throws(() => validateConfig({ ...parsed, body: "sometimes" }), /Invalid body setting/);
});

void test("body resolves project over user and is allowed in .gc.yaml", () => {
	const parsed = validateConfig({
		activeProfile: "personal",
		split: true,
		body: "auto",
		profiles: {
			personal: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5", apiKey: "k" },
		},
	});
	assert.equal(mergeConfig(parsed).body, "auto");
	assert.equal(mergeConfig(parsed, validateProjectConfig({ body: "always" })).body, "always");
	assert.throws(() => validateProjectConfig({ body: "nope" }), /Invalid body setting/);
});
