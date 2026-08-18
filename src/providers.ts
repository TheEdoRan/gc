import { input, search } from "@inquirer/prompts";

export const PROVIDER_PRESETS = {
	openai: {
		label: "OpenAI",
		adapter: "openai",
		baseUrl: "https://api.openai.com/v1",
		requiresApiKey: true,
	},
	anthropic: {
		label: "Anthropic",
		adapter: "anthropic",
		baseUrl: "https://api.anthropic.com/v1",
		requiresApiKey: true,
	},
	cerebras: {
		label: "Cerebras",
		adapter: "compatible",
		baseUrl: "https://api.cerebras.ai/v1",
		requiresApiKey: true,
	},
	chutes: {
		label: "Chutes",
		adapter: "compatible",
		baseUrl: "https://llm.chutes.ai/v1",
		requiresApiKey: true,
	},
	deepinfra: {
		label: "DeepInfra",
		adapter: "compatible",
		baseUrl: "https://api.deepinfra.com/v1/openai",
		requiresApiKey: true,
	},
	deepseek: {
		label: "DeepSeek",
		adapter: "compatible",
		baseUrl: "https://api.deepseek.com/v1",
		requiresApiKey: true,
	},
	fireworks: {
		label: "Fireworks",
		adapter: "compatible",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		requiresApiKey: true,
	},
	gemini: {
		label: "Gemini",
		adapter: "compatible",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
		requiresApiKey: true,
	},
	groq: {
		label: "Groq",
		adapter: "compatible",
		baseUrl: "https://api.groq.com/openai/v1",
		requiresApiKey: true,
	},
	lmstudio: {
		label: "LM Studio",
		adapter: "compatible",
		baseUrl: "http://localhost:1234/v1",
		requiresApiKey: false,
	},
	minimax: {
		label: "MiniMax",
		adapter: "compatible",
		baseUrl: "https://api.minimax.io/v1",
		requiresApiKey: true,
	},
	mistral: {
		label: "Mistral",
		adapter: "compatible",
		baseUrl: "https://api.mistral.ai/v1",
		requiresApiKey: true,
	},
	moonshot: {
		label: "Moonshot",
		adapter: "compatible",
		baseUrl: "https://api.moonshot.ai/v1",
		requiresApiKey: true,
	},
	ollama: {
		label: "Ollama",
		adapter: "compatible",
		baseUrl: "http://localhost:11434/v1",
		requiresApiKey: false,
	},
	openrouter: {
		label: "OpenRouter",
		adapter: "compatible",
		baseUrl: "https://openrouter.ai/api/v1",
		requiresApiKey: true,
	},
	qwen: {
		label: "Qwen",
		adapter: "compatible",
		baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		requiresApiKey: true,
	},
	"qwen-cn": {
		label: "Qwen China",
		adapter: "compatible",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		requiresApiKey: true,
	},
	together: {
		label: "Together",
		adapter: "compatible",
		baseUrl: "https://api.together.xyz/v1",
		requiresApiKey: true,
	},
	xai: {
		label: "xAI",
		adapter: "compatible",
		baseUrl: "https://api.x.ai/v1",
		requiresApiKey: true,
	},
	zai: {
		label: "Z.AI",
		adapter: "compatible",
		baseUrl: "https://api.z.ai/api/paas/v4",
		requiresApiKey: true,
	},
	"zai-coding": {
		label: "Z.AI Coding",
		adapter: "compatible",
		baseUrl: "https://api.z.ai/api/coding/paas/v4",
		requiresApiKey: true,
	},
	compatible: {
		label: "OpenAI-compatible",
		adapter: "compatible",
		baseUrl: "",
		requiresApiKey: false,
	},
} as const;

export type Provider = keyof typeof PROVIDER_PRESETS;

export function isProvider(value: unknown): value is Provider {
	return typeof value === "string" && Object.hasOwn(PROVIDER_PRESETS, value);
}

export interface Profile {
	provider: Provider;
	baseUrl: string;
	model: string;
	apiKey: string;
	maxInputTokens?: number;
	maxOutputTokens?: number;
}

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
	if (PROVIDER_PRESETS[profile.provider].adapter === "anthropic") {
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
