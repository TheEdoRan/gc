import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveDemoOptions } from "../scripts/demo-options.ts";

/**
 * CONTRIBUTING points contributors at `pnpm demo --offline` to see the review flow, so it may not
 * render differently on the maintainer's machine than on theirs. Online is the opposite: running
 * the real profile is the point of the harness.
 */
test("the demo harness pins split and body offline, and reads the config online", () => {
	const configured = { split: false, body: "always" as const };

	assert.deepEqual(resolveDemoOptions({ offline: true }, configured), { split: true, body: "manual" });
	assert.deepEqual(resolveDemoOptions({ offline: true, split: false, body: "auto" }, configured), {
		split: false,
		body: "auto",
	});
	assert.deepEqual(resolveDemoOptions({ offline: false }, configured), configured);
	assert.deepEqual(resolveDemoOptions({ offline: false, body: "manual" }, configured), {
		split: false,
		body: "manual",
	});
});
