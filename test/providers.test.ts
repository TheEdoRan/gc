import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { listModels, selectModel, type ModelPrompts, type Provider } from "../src/providers.ts";

let baseUrl = "";
const requests: Array<{
	url: string;
	authorization: string | undefined;
	apiKey: string | undefined;
	version: string | undefined;
}> = [];
const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(", ") : value);
const server = createServer((request, response) => {
	requests.push({
		url: request.url ?? "",
		authorization: request.headers.authorization,
		apiKey: header(request.headers["x-api-key"]),
		version: header(request.headers["anthropic-version"]),
	});
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify({ data: [{ id: "z-model" }, { id: "a-model" }, { nope: true }] }));
});

before(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address === "object");
	baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

after(() => server.close());

void test("lists and sorts OpenAI models with bearer authentication", async () => {
	assert.deepEqual(await listModels({ provider: "openai", baseUrl, apiKey: "openai-secret" }), ["a-model", "z-model"]);
	assert.deepEqual(requests.at(-1), {
		url: "/v1/models",
		authorization: "Bearer openai-secret",
		apiKey: undefined,
		version: undefined,
	});
});

void test("uses Anthropic model headers", async () => {
	await listModels({ provider: "anthropic", baseUrl, apiKey: "anthropic-secret" });
	assert.deepEqual(requests.at(-1), {
		url: "/v1/models",
		authorization: undefined,
		apiKey: "anthropic-secret",
		version: "2023-06-01",
	});
});

void test("allows a compatible provider without a key", async () => {
	await listModels({ provider: "compatible", baseUrl, apiKey: "" });
	assert.equal(requests.at(-1)?.authorization, undefined);
});

void test("falls back to manual model entry when listing fails", async () => {
	let usedSearch = false;
	const prompts: ModelPrompts = {
		input: async () => "manual-model",
		search: async () => {
			usedSearch = true;
			return "unused";
		},
	};
	const model = await selectModel({ provider: "compatible", baseUrl: "http://127.0.0.1:1/v1", apiKey: "" }, prompts);
	assert.equal(model, "manual-model");
	assert.equal(usedSearch, false);
});

void test("searches the fetched model list", async () => {
	const prompts: ModelPrompts = {
		input: async () => "unused",
		search: async (options: {
			message: string;
			source: (term?: string) => Promise<Array<{ name: string; value: string }>>;
		}) => {
			const { source } = options;
			const choices = await source("z-");
			assert.deepEqual(
				choices.map(({ name }) => name),
				["z-model", "Enter manually"]
			);
			return choices[0]?.value ?? "";
		},
	};
	for (const provider of ["openai", "anthropic", "compatible"] satisfies Provider[]) {
		assert.equal(
			await selectModel({ provider, baseUrl, apiKey: provider === "compatible" ? "" : "key" }, prompts),
			"z-model"
		);
	}
});
