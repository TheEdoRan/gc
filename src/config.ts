import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { confirm, input, password, select } from "@inquirer/prompts";
import envPaths from "env-paths";
import { parseDocument, stringify } from "yaml";

import { DEFAULT_BASE_URLS, selectModel, type Profile, type Provider } from "./providers.ts";

export type { Profile, Provider } from "./providers.ts";

export interface Config {
	activeProfile: string;
	split: boolean;
	profiles: Record<string, Profile>;
}

export interface ConfigPrompts {
	input(options: {
		message: string;
		default?: string;
		validate?: (value: string) => boolean | string;
	}): Promise<string>;
	password(options: {
		message: string;
		mask?: string;
		validate?: (value: string) => boolean | string;
	}): Promise<string>;
	select(options: {
		message: string;
		choices: Array<{ name: string; value: string }>;
		default?: string;
	}): Promise<string>;
	confirm(options: { message: string; default?: boolean }): Promise<boolean>;
}

export interface ConfigOptions {
	path?: string;
	prompts?: ConfigPrompts;
	modelPrompts?: Parameters<typeof selectModel>[1];
	fetcher?: typeof fetch;
}

const configPrompts: ConfigPrompts = {
	input: (options) => input(options),
	password: (options) => password(options),
	select: (options) => select(options),
	confirm: (options) => confirm(options),
};

const configKeys = ["activeProfile", "split", "profiles"];
const profileKeys = ["provider", "baseUrl", "model", "apiKey"];
const providers: Provider[] = ["openai", "anthropic", "compatible"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]) {
	return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isProvider(value: unknown): value is Provider {
	return typeof value === "string" && providers.some((provider) => provider === value);
}

function validUrl(value: string) {
	try {
		return ["http:", "https:"].includes(new URL(value).protocol);
	} catch {
		return false;
	}
}

export function validateConfig(value: unknown): Config {
	if (!isRecord(value) || !exactKeys(value, configKeys)) throw new Error("Invalid config structure");
	if (typeof value.activeProfile !== "string" || !value.activeProfile.trim()) {
		throw new Error("Invalid activeProfile");
	}
	if (typeof value.split !== "boolean") throw new Error("Invalid split setting");
	if (!isRecord(value.profiles) || !Object.keys(value.profiles).length) throw new Error("Invalid profiles");

	const profiles: Record<string, Profile> = {};
	for (const [name, candidate] of Object.entries(value.profiles)) {
		if (!name.trim() || name === "__proto__" || !isRecord(candidate) || !exactKeys(candidate, profileKeys)) {
			throw new Error(`Invalid profile: ${name || "unnamed"}`);
		}
		const { provider, baseUrl, model, apiKey } = candidate;
		if (!isProvider(provider)) {
			throw new Error(`Invalid provider in profile: ${name}`);
		}
		if (typeof baseUrl !== "string" || !validUrl(baseUrl)) throw new Error(`Invalid baseUrl in profile: ${name}`);
		if (typeof model !== "string" || !model.trim()) throw new Error(`Invalid model in profile: ${name}`);
		if (typeof apiKey !== "string" || (provider !== "compatible" && !apiKey)) {
			throw new Error(`Invalid apiKey in profile: ${name}`);
		}
		profiles[name] = { provider, baseUrl, model, apiKey };
	}
	if (!Object.hasOwn(profiles, value.activeProfile)) throw new Error("The active profile does not exist");
	return { activeProfile: value.activeProfile, split: value.split, profiles };
}

export function getConfigPath() {
	return `${envPaths("gc", { suffix: "" }).config}/config.yaml`;
}

export async function readConfig(path = getConfigPath()): Promise<Config | undefined> {
	let source: string;
	try {
		source = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}

	const document = parseDocument(source, { strict: true, uniqueKeys: true });
	if (document.errors.length) throw new Error(`Invalid config YAML: ${document.errors[0]?.message}`);
	return validateConfig(document.toJS({ maxAliasCount: 0 }));
}

export async function writeConfig(config: Config, path = getConfigPath()) {
	const validated = validateConfig(config);
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(stringify(validated, { lineWidth: 0 }), "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await chmod(temporary, 0o600);
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

function profileName(config: Config | undefined, requested: string | undefined, prompts: ConfigPrompts) {
	if (requested) return Promise.resolve(requested);
	return prompts.input({
		message: "Profile name",
		default: config?.activeProfile ?? "personal",
		validate: (value) => value.trim().length > 0 || "Enter a profile name",
	});
}

export async function setupProfile(
	config?: Config,
	requestedName?: string,
	options: ConfigOptions = {}
): Promise<Config> {
	const prompts = options.prompts ?? configPrompts;
	const name = (await profileName(config, requestedName, prompts)).trim();
	if (!name) throw new Error("Profile name cannot be empty");
	const existing = config?.profiles[name];
	const selectedProvider = await prompts.select({
		message: "Provider",
		...(existing ? { default: existing.provider } : {}),
		choices: [
			{ name: "OpenAI", value: "openai" },
			{ name: "Anthropic", value: "anthropic" },
			{ name: "OpenAI-compatible", value: "compatible" },
		],
	});
	if (!isProvider(selectedProvider)) throw new Error("Invalid provider selection");
	const provider = selectedProvider;
	const baseUrl = (
		await prompts.input({
			message: "Base URL",
			default: existing?.provider === provider ? existing.baseUrl : DEFAULT_BASE_URLS[provider],
			validate: (value) => validUrl(value) || "Enter an HTTP or HTTPS URL",
		})
	)
		.trim()
		.replace(/\/$/, "");
	const currentKey = existing?.provider === provider ? existing.apiKey : undefined;
	const enteredKey = await prompts.password({
		message: existing ? "API key (leave blank to keep the current key)" : "API key",
		mask: "*",
		validate: (value) => (provider === "compatible" || value || currentKey ? true : "Enter an API key"),
	});
	const apiKey = enteredKey || currentKey || "";
	const model = await selectModel(
		{ provider, baseUrl, apiKey, ...(existing ? { model: existing.model } : {}) },
		options.modelPrompts,
		options.fetcher
	);
	const next: Config = {
		activeProfile: name,
		split: await prompts.confirm({
			message: "Split unrelated changes into separate commits?",
			default: config?.split ?? true,
		}),
		profiles: { ...config?.profiles, [name]: { provider, baseUrl, apiKey, model: model.trim() } },
	};
	return validateConfig(next);
}

export async function initConfig(requestedName?: string, options: ConfigOptions = {}) {
	const path = options.path ?? getConfigPath();
	const config = await setupProfile(await readConfig(path), requestedName, options);
	await writeConfig(config, path);
	return config;
}

export async function selectProfile(requestedName?: string, options: ConfigOptions = {}) {
	const path = options.path ?? getConfigPath();
	const config = await readConfig(path);
	if (!config) throw new Error("Run gc init first");

	let name = requestedName;
	if (name && !Object.hasOwn(config.profiles, name)) throw new Error(`Unknown profile: ${name}`);
	if (!name) {
		const names = Object.keys(config.profiles);
		if (names.length === 1) {
			const create = await (options.prompts ?? configPrompts).confirm({
				message: "Only one profile exists. Create another?",
				default: true,
			});
			if (!create) return config;
			const updated = await setupProfile(config, undefined, options);
			await writeConfig(updated, path);
			return updated;
		}
		name = await (options.prompts ?? configPrompts).select({
			message: "Active profile",
			choices: names.map((profile) => ({ name: profile, value: profile })),
		});
	}

	const updated = { ...config, activeProfile: name };
	await writeConfig(updated, path);
	return updated;
}

export const runInit = initConfig;
export const runProfile = selectProfile;
