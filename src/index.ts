#!/usr/bin/env node

import { run } from "./cli.ts";

try {
	await run();
} catch (error) {
	if (error instanceof Error && error.name === "ExitPromptError") process.exitCode = 130;
	else {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
