import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import {
	getConfigPath,
	readConfig,
	selectProfile,
	setupProfile,
	validateConfig,
	writeConfig,
	type Config,
	type ConfigPrompts,
} from "../src/config.ts";
import type { ModelPrompts } from "../src/providers.ts";

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
	assert.throws(() => validateConfig({ ...config, activeProfile: "missing" }), /does not exist/);
	assert.throws(
		() =>
			validateConfig({
				...config,
				profiles: { personal: { ...config.profiles.personal, unexpected: true } },
			}),
		/Invalid profile/
	);

	const directory = await mkdtemp(join(tmpdir(), "gc-yaml-"));
	const path = join(directory, "config.yaml");
	await writeFile(path, "activeProfile: one\nactiveProfile: two\nsplit: true\nprofiles: {}\n");
	await assert.rejects(readConfig(path), /Map keys must be unique/);
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
		select: async () => "compatible",
		confirm: async () => false,
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
		split: false,
		profiles: {
			work: { provider: "compatible", baseUrl: "http://localhost:11434/v1", model: "local-model", apiKey: "" },
		},
	});
});

void test("updates a profile without exposing or replacing its stored key", async () => {
	const prompts: ConfigPrompts = {
		input: async () => "https://api.openai.com/v1/",
		password: async () => "",
		select: async () => "openai",
		confirm: async () => true,
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
	assert.equal(updated.profiles.personal?.model, "gpt-new");
	assert.equal(updated.profiles.personal?.baseUrl, "https://api.openai.com/v1");
});

void test("switches the active profile directly", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gc-switch-"));
	const path = join(directory, "config.yaml");
	await writeConfig(
		{
			...config,
			profiles: {
				...config.profiles,
				work: { provider: "compatible", baseUrl: "http://localhost:11434/v1", model: "local", apiKey: "" },
			},
		},
		path
	);
	assert.equal((await selectProfile("work", { path })).activeProfile, "work");
	assert.equal((await readConfig(path))?.activeProfile, "work");
});
