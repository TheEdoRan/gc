import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { createSpinner, createTerminal, frameAt, paint } from "../src/terminal.ts";

function sink() {
	const stream = new PassThrough() as PassThrough & { isTTY?: boolean };
	const chunks: string[] = [];
	stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
	return { stream, text: () => chunks.join("") };
}

test("color is off without a TTY and off when NO_COLOR is set", () => {
	const plain = sink();
	assert.equal(createTerminal(plain.stream, {}).color, false);
	assert.equal(createTerminal(plain.stream, {}).interactive, false);

	const tty = sink();
	tty.stream.isTTY = true;
	assert.equal(createTerminal(tty.stream, {}).color, true);
	assert.equal(createTerminal(tty.stream, { NO_COLOR: "" }).color, false);
	assert.equal(createTerminal(tty.stream, { NO_COLOR: "1" }).color, false);
});

test("paint returns the text unchanged when color is off", () => {
	const plain = sink();
	const off = createTerminal(plain.stream, {});
	assert.equal(paint(off, "green", "feat"), "feat");

	const tty = sink();
	tty.stream.isTTY = true;
	const on = createTerminal(tty.stream, {});
	assert.match(paint(on, "green", "feat"), /\u001b\[32m/);
	assert.match(paint(on, "green", "feat"), /feat/);
});

test("frames advance and wrap", () => {
	assert.equal(frameAt(0), frameAt(10));
	assert.notEqual(frameAt(0), frameAt(1));
});

test("a non-interactive spinner writes plain lines and no escape sequences", () => {
	const plain = sink();
	const spinner = createSpinner(createTerminal(plain.stream, {}), "gpt-5");
	spinner.phase("waiting");
	spinner.subject(0, "feat: something");
	spinner.note("retrying (2/4)");
	spinner.stop();

	const output = plain.text();
	assert.doesNotMatch(output, /\u001b/);
	assert.match(output, /waiting/);
	assert.match(output, /retrying \(2\/4\)/);
	assert.doesNotMatch(output, /feat: something/);
});
