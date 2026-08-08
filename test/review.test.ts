import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import type { CommitPlan } from "../src/ai.ts";
import { initialState, reduce, render, type ReviewKey, type ReviewState } from "../src/review.ts";
import { createTerminal } from "../src/terminal.ts";

const plan: CommitPlan = {
	commits: [
		{ subject: "feat(cli): add the list", body: "", files: ["src/cli.ts", "src/review.ts"] },
		{ subject: "fix(git): keep renames together", body: "Because the pairing is lost.", files: ["src/git.ts"] },
	],
	notice: "2 files shown in full",
};

const key = (name: string, ctrl = false): ReviewKey => ({ name, ctrl, shift: false });
const idle = { text: "", column: 0 };
const plain = createTerminal(new PassThrough(), {});

function press(state: ReviewState, ...names: string[]) {
	let current = state;
	for (const name of names) [current] = reduce(current, key(name), idle);
	return current;
}

test("navigation moves and collapses", () => {
	const start = initialState(plan);
	assert.equal(start.index, 0);
	assert.equal(press(start, "down").index, 1);
	assert.equal(press(start, "up").index, 0, "clamps at the top");
	assert.equal(press(start, "j", "j").index, 1, "clamps at the bottom");
	assert.equal(press(start, "space").expanded, 0);
	assert.equal(press(start, "space", "down").expanded, null, "moving collapses");
	assert.equal(press(start, "space", "space").expanded, null, "space toggles");
});

test("body keys do nothing while the row is collapsed", () => {
	const start = initialState(plan);
	assert.equal(press(start, "i").mode, "list");
	assert.equal(press(start, "x").commits[0]?.body, "");
	assert.deepEqual(reduce(start, key("g"), idle)[1], { type: "none" });
});

test("body keys work once the row is expanded", () => {
	const expanded = press(initialState(plan), "down", "space");
	assert.equal(expanded.expanded, 1);

	const [editing, effect] = reduce(expanded, key("i"), idle);
	assert.equal(editing.mode, "body");
	assert.deepEqual(effect, { type: "load", text: "Because the pairing is lost.", column: 28 });

	assert.deepEqual(reduce(expanded, key("g"), idle)[1], { type: "generate", index: 1 });
	assert.equal(press(expanded, "x").commits[1]?.body, "");
});

test("x is ignored when the row has no body", () => {
	const expanded = press(initialState(plan), "space");
	const [next, effect] = reduce(expanded, key("x"), idle);
	assert.deepEqual(effect, { type: "none" });
	assert.equal(next, expanded, "state is untouched");
});

test("the subject editor saves on enter and refuses an empty subject", () => {
	const [editing, effect] = reduce(initialState(plan), key("e"), idle);
	assert.equal(editing.mode, "subject");
	assert.deepEqual(effect, { type: "load", text: "feat(cli): add the list", column: 23 });

	const [saved] = reduce(editing, key("return"), { text: "feat(cli): a better list", column: 24 });
	assert.equal(saved.mode, "list");
	assert.equal(saved.commits[0]?.subject, "feat(cli): a better list");

	const [refused] = reduce(editing, key("return"), { text: "   ", column: 3 });
	assert.equal(refused.mode, "subject", "stays open");
	assert.match(refused.error ?? "", /cannot be empty/);

	const [cancelled] = reduce(editing, key("escape"), { text: "throw this away", column: 15 });
	assert.equal(cancelled.mode, "list");
	assert.equal(cancelled.commits[0]?.subject, "feat(cli): add the list");
});

test("the body editor splits and joins lines", () => {
	const expanded = press(initialState(plan), "down", "space");
	const [editing] = reduce(expanded, key("i"), idle);

	const [split] = reduce(editing, key("return"), { text: "one two", column: 3 });
	assert.deepEqual(split.buffer, { lines: ["one", " two"], row: 1 });

	const [joined] = reduce(split, key("backspace"), { text: " two", column: 0 });
	assert.deepEqual(joined.buffer, { lines: ["one two"], row: 0 });

	const [done] = reduce(split, key("d", true), { text: " two", column: 4 });
	assert.equal(done.mode, "list");
	assert.equal(done.commits[1]?.body, "one\n two");
});

test("escape aborts a running generation before it cancels the review", () => {
	const generating: ReviewState = { ...initialState(plan), generating: 0 };
	const [same, effect] = reduce(generating, key("escape"), idle);
	assert.deepEqual(effect, { type: "abort" });
	assert.equal(same.done, null);

	const [cancelled] = reduce(initialState(plan), key("escape"), idle);
	assert.equal(cancelled.done, "cancel");
});

test("mutating keys are ignored while a body is generating, navigation is not", () => {
	const generating: ReviewState = { ...initialState(plan), generating: 0 };
	for (const name of ["e", "i", "g", "x", "r", "return"]) {
		assert.equal(press(generating, name).done, null, `${name} must not finish the review`);
		assert.equal(press(generating, name).mode, "list", `${name} must not open an editor`);
	}
	assert.equal(press(generating, "down").index, 1, "navigation still works");
	assert.equal(press(generating, "q").done, "cancel", "q always cancels");
});

test("enter commits and r regenerates", () => {
	assert.equal(press(initialState(plan), "return").done, "commit");
	assert.equal(press(initialState(plan), "r").done, "regenerate");
	assert.equal(press(initialState(plan), "q").done, "cancel");
});

test("ctrl+e asks for the external editor from anywhere", () => {
	assert.deepEqual(reduce(initialState(plan), key("e", true), idle)[1], { type: "editor", index: 0 });
});

test("render shows the collapsed list, then the body, then the empty-body notice", () => {
	const start = initialState(plan);
	const [collapsed] = render(start, idle, plain, 80);
	assert.match(collapsed, /feat\(cli\): add the list/);
	assert.match(collapsed, /src\/cli\.ts/);
	assert.doesNotMatch(collapsed, /Because the pairing is lost/, "a collapsed body stays hidden");
	assert.match(collapsed, /2 commits/);
	assert.match(collapsed, /2 files shown in full/);
	assert.doesNotMatch(collapsed, /\u001b/, "no colour without a TTY");

	const [withBody] = render(press(start, "down", "space"), idle, plain, 80);
	assert.match(withBody, /Because the pairing is lost/);

	const [noBody] = render(press(start, "space"), idle, plain, 80);
	assert.match(noBody, /No body for this commit/);
});

test("the hint line is contextual", () => {
	const start = initialState(plan);
	assert.match(render(start, idle, plain, 80)[1], /space expand/);
	assert.match(render(press(start, "space"), idle, plain, 80)[1], /i write body/);
	assert.doesNotMatch(render(press(start, "space"), idle, plain, 80)[1], /x drop body/);
	assert.match(render(press(start, "down", "space"), idle, plain, 80)[1], /x drop body/);
	assert.match(render(press(start, "down", "space"), idle, plain, 80)[1], /i edit body/);

	const generating: ReviewState = { ...initialState(plan), generating: 0 };
	assert.match(render(generating, idle, plain, 80)[1], /esc cancel generation/);
});

test("navigation clamps on a single-commit plan", () => {
	const one = initialState({ commits: [{ subject: "chore: only one", body: "", files: ["a.ts"] }] });
	for (const name of ["up", "k", "down", "j"]) {
		const [next, effect] = reduce(one, key(name), idle);
		assert.equal(next, one, `${name} leaves the state untouched`);
		assert.deepEqual(effect, { type: "none" });
	}
	assert.equal(press(one, "space", "down").expanded, 0, "a clamped move does not collapse");
	assert.match(render(one, idle, plain, 80)[0], /1 commit · 1 file\b/, "singular counts read correctly");
});

test("navigation never leaves the array on an empty plan", () => {
	const empty = initialState({ commits: [] });
	assert.equal(press(empty, "down").index, 0);
	assert.equal(press(empty, "up").index, 0);
});

test("body actions stay locked while another row is generating", () => {
	const expanded = press(initialState(plan), "down", "space");
	const generating: ReviewState = { ...expanded, generating: 0 };
	for (const name of ["i", "g", "x"]) {
		const [next, effect] = reduce(generating, key(name), idle);
		assert.equal(next, generating, `${name} leaves the state untouched`);
		assert.deepEqual(effect, { type: "none" });
	}
	assert.deepEqual(reduce(generating, key("e", true), idle)[1], { type: "none" }, "ctrl+e is locked too");
});

test("an open editor keeps the keys the list would otherwise claim", () => {
	const [editing] = reduce(initialState(plan), key("e"), idle);
	for (const name of ["space", "q", "j", "x"]) {
		const [next, effect] = reduce(editing, key(name), { text: "feat(cli): typing", column: 17 });
		assert.equal(next, editing, `${name} is readline's business in subject mode`);
		assert.deepEqual(effect, { type: "none" });
	}

	const [writing] = reduce(press(initialState(plan), "down", "space"), key("i"), idle);
	const [next, effect] = reduce(writing, key("q"), { text: "unsaved words", column: 13 });
	assert.equal(next, writing, "q types a letter instead of cancelling the review");
	assert.deepEqual(effect, { type: "none" });
	assert.equal(next.commits[1]?.body, "Because the pairing is lost.", "nothing is saved yet");
});

test("backspace at the very start of the body does nothing", () => {
	const [writing] = reduce(press(initialState(plan), "down", "space"), key("i"), idle);
	const [next, effect] = reduce(writing, key("backspace"), { text: "Because the pairing is lost.", column: 0 });
	assert.deepEqual(effect, { type: "none" }, "no line join, so readline must not be reloaded");
	assert.deepEqual(next.buffer, { lines: ["Because the pairing is lost."], row: 0 });
});

test("reduce leaves the caller's plan alone", () => {
	const before = structuredClone(plan);
	const start = initialState(plan);
	const [edited] = reduce(reduce(start, key("e"), idle)[0], key("return"), { text: "feat: renamed", column: 13 });
	const dropped = press(press(edited, "down", "space"), "x");

	assert.equal(dropped.commits[0]?.subject, "feat: renamed");
	assert.equal(dropped.commits[1]?.body, "");
	assert.deepEqual(plan, before, "the plan handed in is never written to");
	assert.equal(start.commits[0]?.subject, "feat(cli): add the list", "the earlier state is never written to");
});

test("render survives odd commits and narrow terminals", () => {
	const odd = initialState({
		commits: [
			{ subject: "no conventional prefix here", body: "x".repeat(120), files: [] },
			{ subject: "feat: normal", body: "", files: ["a.ts", "b.ts", "c.ts", "d.ts"] },
		],
	});
	const [content] = render({ ...odd, expanded: 0 }, idle, plain, 20);
	assert.match(content, /no conventional prefix here/, "an unrecognised subject is left alone");
	assert.match(content, new RegExp(`x{120}`), "an unbreakable word overflows rather than looping");
	assert.match(content, /\+1 more/, "a collapsed row shows only the first files");
});

test("the generating row is marked even when the selection moved away", () => {
	const generating: ReviewState = { ...initialState(plan), generating: 1 };
	assert.match(render(generating, idle, plain, 80)[0], /writing body/);
});
