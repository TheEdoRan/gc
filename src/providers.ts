import { input, search } from "@inquirer/prompts";

export type Provider = "openai" | "anthropic" | "compatible";

export interface Profile {
	provider: Provider;
	baseUrl: string;
	model: string;
	apiKey: string;
	maxInputTokens?: number;
	maxOutputTokens?: number;
}

export const DEFAULT_BASE_URLS = {
	openai: "https://api.openai.com/v1",
	anthropic: "https://api.anthropic.com/v1",
	compatible: "",
} as const satisfies Record<Provider, string>;

export interface ModelPrompts {
	input(options: {
		message: string;
		default?: string;
		validate?: (value: string) => boolean | string;
	}): Promise<string>;
	search(options: {
		message: string;
		source: (term?: string) => Promise<Array<{ name: string; value: string }>>;
	}): Promise<string>;
}

const modelPrompts: ModelPrompts = {
	input: (options) => input(options),
	search: (options) => search(options),
};

function modelInput(prompts: ModelPrompts, current?: string) {
	return prompts.input({
		message: "Model",
		...(current ? { default: current } : {}),
		validate: (value) => value.trim().length > 0 || "Enter a model",
	});
}

function modelsUrl(baseUrl: string): URL {
	const url = new URL(baseUrl);
	url.pathname = `${url.pathname.replace(/\/$/, "")}/models`;
	url.search = "";
	url.hash = "";
	return url;
}

export async function listModels(profile: Pick<Profile, "provider" | "baseUrl" | "apiKey">, fetcher = fetch) {
	const headers = new Headers({ accept: "application/json" });
	if (profile.provider === "anthropic") {
		if (profile.apiKey) headers.set("x-api-key", profile.apiKey);
		headers.set("anthropic-version", "2023-06-01");
	} else if (profile.apiKey) {
		headers.set("authorization", `Bearer ${profile.apiKey}`);
	}

	const response = await fetcher(modelsUrl(profile.baseUrl), { headers });
	if (!response.ok) throw new Error(`Could not list models (${response.status})`);

	const body: unknown = await response.json();
	if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) {
		throw new Error("The model list response is invalid");
	}

	const models = body.data
		.map((item: unknown) =>
			item && typeof item === "object" && "id" in item && typeof item.id === "string" ? item.id : undefined
		)
		.filter((id): id is string => Boolean(id));
	if (!models.length) throw new Error("The provider returned no models");
	return [...new Set(models)].toSorted();
}

export async function selectModel(
	profile: Pick<Profile, "provider" | "baseUrl" | "apiKey"> & Partial<Pick<Profile, "model">>,
	prompts: ModelPrompts = modelPrompts,
	fetcher = fetch
) {
	let models: string[];
	try {
		models = await listModels(profile, fetcher);
	} catch {
		return modelInput(prompts, profile.model);
	}

	const manual = "\0manual";
	const selected = await prompts.search({
		message: "Model",
		source: async (term = "") => [
			...models
				.filter((model) => model.toLowerCase().includes(term.toLowerCase()))
				.map((model) => ({ name: model, value: model })),
			{ name: "Enter manually", value: manual },
		],
	});
	return selected === manual ? modelInput(prompts, profile.model) : selected;
}
