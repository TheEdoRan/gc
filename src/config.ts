import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { styleText } from "node:util";

import { createPrompt, isDownKey, isEnterKey, isUpKey, useKeypress, usePagination, useState } from "@inquirer/core";
import { confirm, input, password, search, select } from "@inquirer/prompts";
import envPaths from "env-paths";
import { parseDocument, stringify } from "yaml";

import { isProvider, PROVIDER_PRESETS, selectModel, type Profile } from "./providers.ts";

export type { Profile, Provider } from "./providers.ts";

export interface Config {
	activeProfile: string;
	split: boolean;
	profiles: Record<string, Profile>;
	excludeContent?: string[];
	includeContent?: string[];
	body?: BodyMode;
}

/** `<repo>/.gc.yaml`. Committed to the repository, so it can never carry credentials. */
export interface ProjectConfig {
	excludeContent?: string[];
	includeContent?: string[];
	split?: boolean;
	body?: BodyMode;
}

export type BodyMode = "manual" | "auto" | "always";
export const BODY_MODES: readonly BodyMode[] = ["manual", "auto", "always"];

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
	search(options: {
		message: string;
		default?: string;
		source: (term?: string) => Promise<Array<{ name: string; value: string }>>;
	}): Promise<string>;
	confirm(options: { message: string; default?: boolean }): Promise<boolean>;
}

export interface ConfigOptions {
	path?: string;
	prompts?: ConfigPrompts;
	profilePrompt?: typeof profilePrompt;
	setupPrompt?: typeof setupPrompt;
	modelPrompts?: Parameters<typeof selectModel>[1];
	fetcher?: typeof fetch;
}

export type ProfileAction = { action: "select" | "edit" | "delete"; name: string } | { action: "add" };

export const profilePrompt = createPrompt<ProfileAction, { profiles: string[]; activeProfile: string }>(
	({ profiles, activeProfile }, done) => {
		const [active, setActive] = useState(Math.max(profiles.indexOf(activeProfile), 0));
		const [error, setError] = useState("");

		useKeypress((key, readline) => {
			readline.clearLine(0);
			setError("");
			if (isUpKey(key) || isDownKey(key)) {
				setActive((active + (isUpKey(key) ? -1 : 1) + profiles.length) % profiles.length);
			} else if (isEnterKey(key)) {
				done({ action: "select", name: profiles[active]! });
			} else if (key.name === "e" && !key.ctrl) {
				done({ action: "edit", name: profiles[active]! });
			} else if (key.name === "d" && !key.ctrl) {
				if (profiles.length === 1) setError("The only profile cannot be deleted.");
				else done({ action: "delete", name: profiles[active]! });
			} else if (key.name === "a" && !key.ctrl) {
				done({ action: "add" });
			}
		});

		const page = usePagination({
			items: profiles,
			active,
			pageSize: 7,
			renderItem: ({ item, isActive }) => {
				const line = `${isActive ? "\u276f" : " "} ${item}${item === activeProfile ? ` ${styleText("dim", "(active)")}` : ""}`;
				return isActive ? styleText("cyan", line) : line;
			},
		});
		return `? Profile list\n${page}\n${error ? `${styleText("red", error)}\n` : ""}\u2191\u2193 move \u00b7 \u21b5 make active \u00b7 a add \u00b7 e edit \u00b7 d delete\u001b[?25l`;
	}
);

type SetupSettings = { split: boolean; body: BodyMode };

function renderOptions(values: readonly string[], selected: string) {
	return values.map((value) => styleText(value === selected ? "cyan" : "dim", value)).join(" ");
}

export const setupPrompt = createPrompt<SetupSettings, SetupSettings>((config, done) => {
	const [active, setActive] = useState(0);
	const [split, setSplit] = useState(config.split);
	const [body, setBody] = useState(config.body);
	const items = [
		`Commit splitting: ${renderOptions(["on", "off"], split ? "on" : "off")}`,
		`Commit body: ${renderOptions(BODY_MODES, body)}`,
	];

	useKeypress((key, readline) => {
		readline.clearLine(0);
		const direction =
			key.name === "left" || (key.name === "h" && !key.ctrl)
				? -1
				: key.name === "space" || key.name === "right" || (key.name === "l" && !key.ctrl)
					? 1
					: 0;
		if (isUpKey(key) || isDownKey(key)) {
			setActive((active + (isUpKey(key) ? -1 : 1) + items.length) % items.length);
		} else if (direction && active === 0) {
			setSplit(!split);
		} else if (direction && active === 1) {
			setBody(BODY_MODES[(BODY_MODES.indexOf(body) + direction + BODY_MODES.length) % BODY_MODES.length]!);
		} else if (isEnterKey(key)) {
			done({ split, body });
		}
	});

	const page = usePagination({
		items,
		active,
		pageSize: 2,
		renderItem: ({ item, isActive }) => {
			const line = `${isActive ? "\u276f" : " "} ${item}`;
			return isActive ? styleText("cyan", line) : line;
		},
	});
	return `? Setup\n${page}\n\u2191\u2193 move \u00b7 \u2190\u2192 h/l space change \u00b7 \u21b5 save and exit\u001b[?25l`;
});

const configPrompts: ConfigPrompts = {
	input: (options) => input(options),
	password: (options) => password(options),
	select: (options) => select(options),
	search: (options) => search(options),
	confirm: (options) => confirm(options),
};

const bodyChoices = [
	{ name: "Only when I ask for one", value: "manual" },
	{ name: "When the subject cannot carry the change", value: "auto" },
	{ name: "Always", value: "always" },
];

const configKeys = ["activeProfile", "split", "profiles"];
const optionalConfigKeys = ["excludeContent", "includeContent", "body"];
const profileKeys = ["provider", "baseUrl", "model", "apiKey"];
const projectKeys = ["excludeContent", "includeContent", "split", "body"];
/** Credentials must come from the user config only, never from a file committed to a repository. */
const forbiddenProjectKeys = ["apiKey", "profiles", "activeProfile"];
const maxInputTokensLimit = 2_000_000;
const maxOutputTokensLimit = 200_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Required keys must all be present, optional ones may be absent, anything else is rejected. */
function allowedKeys(value: Record<string, unknown>, required: string[], optional: string[]) {
	return (
		required.every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
	);
}

function isGlobList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((glob) => typeof glob === "string" && glob.trim().length > 0);
}

function globs(value: Record<string, unknown>, key: string, label: string) {
	if (!Object.hasOwn(value, key)) return {};
	if (!isGlobList(value[key])) throw new Error(`Invalid ${key} in ${label}`);
	return { [key]: value[key] } as Record<string, string[]>;
}

function isBodyMode(value: unknown): value is BodyMode {
	return typeof value === "string" && BODY_MODES.some((mode) => mode === value);
}

function bodyMode(value: Record<string, unknown>, key: string) {
	if (!Object.hasOwn(value, key)) return {};
	if (!isBodyMode(value[key])) throw new Error(`Invalid body setting: expected one of ${BODY_MODES.join(", ")}`);
	return { body: value[key] };
}

function validUrl(value: string) {
	try {
		return ["http:", "https:"].includes(new URL(value).protocol);
	} catch {
		return false;
	}
}

export function validateConfig(value: unknown): Config {
	if (!isRecord(value) || !allowedKeys(value, configKeys, optionalConfigKeys)) {
		throw new Error("Invalid config structure");
	}
	if (typeof value.activeProfile !== "string" || !value.activeProfile.trim()) {
		throw new Error("Invalid activeProfile");
	}
	if (typeof value.split !== "boolean") throw new Error("Invalid split setting");
	if (!isRecord(value.profiles) || !Object.keys(value.profiles).length) throw new Error("Invalid profiles");

	const profiles: Record<string, Profile> = {};
	for (const [name, candidate] of Object.entries(value.profiles)) {
		if (
			!name.trim() ||
			name === "__proto__" ||
			!isRecord(candidate) ||
			!allowedKeys(candidate, profileKeys, ["maxInputTokens", "maxOutputTokens"])
		) {
			throw new Error(`Invalid profile: ${name || "unnamed"}`);
		}
		const { provider, baseUrl, model, apiKey, maxInputTokens, maxOutputTokens } = candidate;
		if (!isProvider(provider)) {
			throw new Error(`Invalid provider in profile: ${name}`);
		}
		if (typeof baseUrl !== "string" || !validUrl(baseUrl)) throw new Error(`Invalid baseUrl in profile: ${name}`);
		if (typeof model !== "string" || !model.trim()) throw new Error(`Invalid model in profile: ${name}`);
		if (typeof apiKey !== "string" || (PROVIDER_PRESETS[provider].requiresApiKey && !apiKey)) {
			throw new Error(`Invalid apiKey in profile: ${name}`);
		}
		if (
			maxInputTokens !== undefined &&
			(typeof maxInputTokens !== "number" ||
				!Number.isSafeInteger(maxInputTokens) ||
				maxInputTokens <= 0 ||
				maxInputTokens > maxInputTokensLimit)
		) {
			throw new Error(`Invalid maxInputTokens in profile: ${name}`);
		}
		if (
			maxOutputTokens !== undefined &&
			(typeof maxOutputTokens !== "number" ||
				!Number.isSafeInteger(maxOutputTokens) ||
				maxOutputTokens <= 0 ||
				maxOutputTokens > maxOutputTokensLimit)
		) {
			throw new Error(`Invalid maxOutputTokens in profile: ${name}`);
		}
		profiles[name] = {
			provider,
			baseUrl,
			model,
			apiKey,
			...(maxInputTokens === undefined ? {} : { maxInputTokens }),
			...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
		};
	}
	if (!Object.hasOwn(profiles, value.activeProfile)) throw new Error("The active profile does not exist");
	return {
		activeProfile: value.activeProfile,
		split: value.split,
		profiles,
		...globs(value, "excludeContent", "config"),
		...globs(value, "includeContent", "config"),
		...bodyMode(value, "body"),
	};
}

export function validateProjectConfig(value: unknown): ProjectConfig {
	if (!isRecord(value)) throw new Error("Invalid project config structure");
	for (const key of forbiddenProjectKeys) {
		if (Object.hasOwn(value, key)) {
			throw new Error(
				`${key} is not allowed in .gc.yaml: the project file is committed to the repository and cannot define or redirect credentials. Set it in the user config instead.`
			);
		}
	}
	if (!allowedKeys(value, [], projectKeys)) throw new Error("Invalid project config structure");
	if (Object.hasOwn(value, "split") && typeof value.split !== "boolean") {
		throw new Error("Invalid split setting in project config");
	}
	return {
		...globs(value, "excludeContent", "project config"),
		...globs(value, "includeContent", "project config"),
		...(Object.hasOwn(value, "split") ? { split: value.split as boolean } : {}),
		...bodyMode(value, "body"),
	};
}

export async function readProjectConfig(root: string): Promise<ProjectConfig | undefined> {
	let source: string;
	try {
		source = await readFile(join(root, ".gc.yaml"), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}

	const document = parseDocument(source, { strict: true, uniqueKeys: true });
	if (document.errors.length) throw new Error(`Invalid project config YAML: ${document.errors[0]?.message}`);
	const parsed: unknown = document.toJS({ maxAliasCount: 0 });
	if (isRecord(parsed) && Object.hasOwn(parsed, "__proto__")) throw new Error("Invalid project config structure");
	return validateProjectConfig(parsed);
}

/** Project globs extend the global ones. Project `split` and `body` override their user defaults. */
export function mergeConfig(global: Config, project?: ProjectConfig) {
	return {
		excludeContent: [...(global.excludeContent ?? []), ...(project?.excludeContent ?? [])],
		includeContent: [...(global.includeContent ?? []), ...(project?.includeContent ?? [])],
		split: project?.split ?? global.split,
		body: project?.body ?? global.body ?? "manual",
	};
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

function profileName(
	config: Config | undefined,
	requested: string | undefined,
	prompts: ConfigPrompts,
	newProfile: boolean
) {
	if (requested) return Promise.resolve(requested);
	return prompts.input({
		message: "Profile name",
		...(!newProfile ? { default: config?.activeProfile ?? "personal" } : {}),
		validate: (value) => {
			const name = value.trim();
			if (!name) return "Enter a profile name";
			return !newProfile || !config || !Object.hasOwn(config.profiles, name) || "That profile already exists";
		},
	});
}

export async function setupProfile(
	config?: Config,
	requestedName?: string,
	options: ConfigOptions = {},
	newProfile = false
): Promise<Config> {
	const prompts = options.prompts ?? configPrompts;
	const name = (await profileName(config, requestedName, prompts, newProfile)).trim();
	if (!name) throw new Error("Profile name cannot be empty");
	if (newProfile && config && Object.hasOwn(config.profiles, name)) throw new Error(`Profile already exists: ${name}`);
	const existing = config?.profiles[name];
	const selectedProvider = await prompts.search({
		message: "Provider",
		...(existing ? { default: existing.provider } : {}),
		source: async (term = "") =>
			Object.entries(PROVIDER_PRESETS)
				.filter(([id, preset]) => `${preset.label} ${id}`.toLowerCase().includes(term.toLowerCase()))
				.map(([value, preset]) => ({ name: preset.label, value })),
	});
	if (!isProvider(selectedProvider)) throw new Error("Invalid provider selection");
	const provider = selectedProvider;
	const baseUrl = (
		await prompts.input({
			message: "Base URL",
			default: existing?.provider === provider ? existing.baseUrl : PROVIDER_PRESETS[provider].baseUrl,
			validate: (value) => validUrl(value) || "Enter an HTTP or HTTPS URL",
		})
	)
		.trim()
		.replace(/\/$/, "");
	const currentKey = existing?.apiKey;
	const enteredKey = await prompts.password({
		message: existing ? "API key (leave blank to keep the current key)" : "API key",
		mask: "*",
		validate: (value) =>
			PROVIDER_PRESETS[provider].requiresApiKey && !value && !currentKey ? "Enter an API key" : true,
	});
	const apiKey = enteredKey || currentKey || "";
	const model = await selectModel(
		{ provider, baseUrl, apiKey, ...(existing ? { model: existing.model } : {}) },
		options.modelPrompts,
		options.fetcher
	);
	// Keep the fields the prompts never ask about instead of silently dropping them on an update.
	const next: Config = {
		activeProfile: name,
		split: config?.split ?? true,
		body: config?.body ?? "manual",
		profiles: {
			...config?.profiles,
			[name]: {
				provider,
				baseUrl,
				apiKey,
				model: model.trim(),
				...(existing?.maxInputTokens ? { maxInputTokens: existing.maxInputTokens } : {}),
				...(existing?.maxOutputTokens ? { maxOutputTokens: existing.maxOutputTokens } : {}),
			},
		},
		...(config?.excludeContent ? { excludeContent: config.excludeContent } : {}),
		...(config?.includeContent ? { includeContent: config.includeContent } : {}),
	};
	return validateConfig(next);
}

export async function initConfig(requestedName?: string, options: ConfigOptions = {}) {
	const path = options.path ?? getConfigPath();
	const current = await readConfig(path);
	const prompts = options.prompts ?? configPrompts;
	if (
		current &&
		!(await prompts.confirm({
			message: "Re-initialize gc config?",
			default: false,
		}))
	) {
		return undefined;
	}
	const profile = await setupProfile(undefined, requestedName, options);
	const config = await setupGlobalSettings(profile, prompts);
	await writeConfig(config, path);
	return config;
}

async function setupGlobalSettings(config: Config, prompts: ConfigPrompts) {
	const body = await prompts.select({
		message: "Commit bodies",
		default: config.body ?? "manual",
		choices: bodyChoices,
	});
	if (!isBodyMode(body)) throw new Error("Invalid body selection");
	return validateConfig({
		...config,
		body,
		split: await prompts.confirm({
			message: "Split unrelated changes into separate commits?",
			default: config.split,
		}),
	});
}

export async function setupConfig(options: ConfigOptions = {}) {
	const path = options.path ?? getConfigPath();
	const current = await readConfig(path);
	if (!current) throw new Error("Run gc init first");
	const choice = await (options.setupPrompt ?? setupPrompt)({
		split: current.split,
		body: current.body ?? "manual",
	});
	const config = validateConfig({ ...current, split: choice.split, body: choice.body });
	await writeConfig(config, path);
	return config;
}

export async function selectProfile(requestedName?: string, options: ConfigOptions = {}) {
	const path = options.path ?? getConfigPath();
	const config = await readConfig(path);
	if (!config) throw new Error("Run gc init first");

	if (requestedName && !Object.hasOwn(config.profiles, requestedName)) {
		throw new Error(`Unknown profile: ${requestedName}`);
	}
	const choice = requestedName
		? { action: "select" as const, name: requestedName }
		: await (options.profilePrompt ?? profilePrompt)({
				profiles: [
					config.activeProfile,
					...Object.keys(config.profiles).filter((name) => name !== config.activeProfile),
				],
				activeProfile: config.activeProfile,
			});

	if (choice.action === "add") {
		const updated = await setupProfile(config, undefined, options, true);
		await writeConfig(updated, path);
		return updated;
	}

	if (choice.action === "edit") {
		const edited = await setupProfile(config, choice.name, options);
		const updated = { ...edited, activeProfile: config.activeProfile };
		await writeConfig(updated, path);
		return updated;
	}
	if (choice.action === "delete") {
		const remove = await (options.prompts ?? configPrompts).confirm({
			message: `Delete profile "${choice.name}"?`,
			default: false,
		});
		if (!remove) return config;
		const profiles = { ...config.profiles };
		delete profiles[choice.name];
		const updated = {
			...config,
			profiles,
			activeProfile: choice.name === config.activeProfile ? Object.keys(profiles)[0]! : config.activeProfile,
		};
		await writeConfig(updated, path);
		return updated;
	}

	const updated = { ...config, activeProfile: choice.name };
	await writeConfig(updated, path);
	return updated;
}

export const runInit = initConfig;
export const runProfile = selectProfile;
export const runSetup = setupConfig;
