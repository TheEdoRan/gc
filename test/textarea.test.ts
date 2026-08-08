import assert from "node:assert/strict";
import { test } from "node:test";

import { activeLine, fromText, joinPrevious, moveRow, setLine, splitLine, toText } from "../src/textarea.ts";

test("text round trips through the buffer", () => {
	assert.deepEqual(fromText(""), { lines: [""], row: 0 });
	assert.deepEqual(fromText("a\nb"), { lines: ["a", "b"], row: 0 });
	assert.equal(toText(fromText("a\nb")), "a\nb");
	assert.equal(toText(fromText("a\r\nb")), "a\nb");
	assert.equal(activeLine(fromText("a\nb")), "a");
});

test("setLine replaces only the active line", () => {
	const buffer = moveRow(fromText("a\nb"), 1);
	assert.deepEqual(setLine(buffer, "z"), { lines: ["a", "z"], row: 1 });
});

test("splitLine cuts at the column and moves down", () => {
	assert.deepEqual(splitLine(fromText("hello"), "hello", 2), { lines: ["he", "llo"], row: 1 });
	assert.deepEqual(splitLine(fromText("hello"), "hello", 0), { lines: ["", "hello"], row: 1 });
	assert.deepEqual(splitLine(fromText("hello"), "hello", 5), { lines: ["hello", ""], row: 1 });
});

test("joinPrevious merges upward and reports the join column", () => {
	const buffer = moveRow(fromText("ab\ncd"), 1);
	assert.deepEqual(joinPrevious(buffer, "cd"), { buffer: { lines: ["abcd"], row: 0 }, column: 2 });

	const top = fromText("ab\ncd");
	const result = joinPrevious(top, "ab");
	assert.deepEqual(result, { buffer: top, column: 0 });
	assert.equal(result.buffer, top);
});

test("moveRow clamps at both ends", () => {
	const buffer = fromText("a\nb\nc");
	const lowerClamped = moveRow(buffer, -1);
	assert.equal(lowerClamped.row, 0);
	assert.equal(lowerClamped, buffer);
	const atEnd = moveRow(buffer, 5);
	assert.equal(atEnd.row, 2);
	const upperClamped = moveRow(atEnd, 1);
	assert.equal(upperClamped.row, 2);
	assert.equal(upperClamped, atEnd);
	assert.equal(moveRow(buffer, 1).row, 1);
});

test("multi-byte characters survive a split", () => {
	assert.deepEqual(splitLine(fromText("héllo"), "héllo", 2), { lines: ["hé", "llo"], row: 1 });
	assert.deepEqual(splitLine(fromText("a🙂b"), "a🙂b", 1), { lines: ["a", "🙂b"], row: 1 });
});

test("no function mutates the input", () => {
	const input = fromText("a\nb\nc");
	Object.freeze(input.lines);
	Object.freeze(input);

	activeLine(input);
	toText(input);
	setLine(input, "x");
	splitLine(input, "a", 0);
	moveRow(input, 1);
	moveRow(input, -1);
	joinPrevious(input, "a");

	assert.deepEqual(input, { lines: ["a", "b", "c"], row: 0 });
});
