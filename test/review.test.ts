import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

import type { CommitPlan } from "../src/ai.ts";
import {
	editorSeed,
	initialState,
	parseEditedMessage,
	normalizeKey,
	reduce,
	render,
	reviewCommits,
	type ReviewConfig,
	type ReviewKey,
	type ReviewState,
} from "../src/review.ts";
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

/**
 * What @inquirer/core's ScreenManager does with `content`: it takes the last line, strips the escape
 * sequences, and cuts `rl.line.length` characters off the end. What remains is the prompt it hands
 * to readline, and its width is the column the terminal cursor starts from.
 */
function promptOf(content: string, line: string): string {
	const last = stripVTControlCharacters(content.split("\n").pop() ?? "");
	return line.length > 0 ? last.slice(0, -line.length) : last;
}

/** The hint bar: the last line the prompt draws. */
function hintOf(state: ReviewState): string {
	const [, bottom] = render(state, idle, plain, 80);
	return stripVTControlCharacters(bottom.split("\n").pop() ?? "");
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

test("g and x do nothing while the row is collapsed", () => {
	const start = initialState(plan);
	// Row 1 is the one with a body, so this fails loudly if a collapsed x ever fires.
	assert.equal(press(start, "down", "x").commits[1]?.body, "Because the pairing is lost.");
	assert.deepEqual(reduce(start, key("g"), idle)[1], { type: "none" });
});

test("b opens the body box from a collapsed row, expanding it", () => {
	const [editing, effect] = reduce(press(initialState(plan), "down"), key("b"), idle);
	assert.equal(editing.mode, "body");
	assert.equal(editing.expanded, 1, "the row is expanded on the way in");
	assert.deepEqual(effect, { type: "load", text: "Because the pairing is lost.", column: 28 });
});

test("body keys work once the row is expanded", () => {
	const expanded = press(initialState(plan), "down", "space");
	assert.equal(expanded.expanded, 1);

	const [editing, effect] = reduce(expanded, key("b"), idle);
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
	const [editing] = reduce(expanded, key("b"), idle);

	const [split] = reduce(editing, key("return"), { text: "one two", column: 3 });
	assert.deepEqual(split.buffer, { lines: ["one", " two"], row: 1 });

	const [joined] = reduce(split, key("backspace"), { text: " two", column: 0 });
	assert.deepEqual(joined.buffer, { lines: ["one two"], row: 0 });

	const [typed] = reduce(split, key("d", true), { text: " two", column: 4 });
	assert.equal(typed.mode, "body", "ctrl+d is readline's, not a save");

	const [done] = reduce(split, key("escape"), { text: " two", column: 4 });
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
	for (const name of ["e", "b", "g", "x", "r", "return"]) {
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

const ESC = String.fromCharCode(27);
const csi = (body: string): ReviewKey & { sequence: string } => ({
	name: "undefined",
	ctrl: false,
	shift: false,
	sequence: `${ESC}[${body}u`,
});

test("shift+enter commits and pushes, and the hint says so", () => {
	const [next] = reduce(initialState(plan), { name: "return", ctrl: false, shift: true }, idle);
	assert.equal(next.done, "push");
	assert.match(hintOf(initialState(plan)), /↵ commit \(⇧↵ to push\)/);
});

test("normalizeKey reads the sequences node cannot name", () => {
	assert.deepEqual(normalizeKey(csi("13;2")), { name: "return", ctrl: false, shift: true });
	assert.deepEqual(normalizeKey(csi("27")), { name: "escape", ctrl: false, shift: false });
	assert.deepEqual(normalizeKey(csi("101;5")), { name: "e", ctrl: true, shift: false });
	assert.deepEqual(normalizeKey(csi("99;5")), { name: "c", ctrl: true, shift: false });

	// The older spelling of shift+enter, for a terminal bound to send it.
	assert.deepEqual(normalizeKey({ name: "return", ctrl: false, shift: false, sequence: `${ESC}\r` }), {
		name: "return",
		ctrl: false,
		shift: true,
	});

	// A key node already named is left exactly as it came.
	const named = { name: "up", ctrl: false, shift: false, sequence: `${ESC}[A` };
	assert.equal(normalizeKey(named), named);
});

test("ctrl+e asks for the external editor from anywhere", () => {
	assert.deepEqual(reduce(initialState(plan), key("e", true), idle)[1], { type: "editor", index: 0 });
});

test("render shows the collapsed list, then the body, then the empty-body notice", () => {
	const start = initialState(plan);
	const [collapsed] = render(start, idle, plain, 80);
	assert.match(collapsed, /feat\(cli\): add the list/);
	assert.match(collapsed, /src\/cli\.ts/);
	assert.match(collapsed, /^ {2}│ Because the pairing is lost\.$/m, "a collapsed body is previewed");
	assert.match(collapsed, /2 commits/);
	assert.match(collapsed, /2 files shown in full/);
	assert.doesNotMatch(collapsed, /No body for this commit/, "but a row without one says nothing");
	assert.doesNotMatch(collapsed, /\u001b/, "no colour without a TTY");

	const [withBody] = render(press(start, "down", "space"), idle, plain, 80);
	assert.match(withBody, /Because the pairing is lost/);

	const [noBody] = render(press(start, "space"), idle, plain, 80);
	assert.match(noBody, /No body for this commit/);
});

test("a collapsed body is cut to three lines and marked", () => {
	const long = initialState({
		commits: [{ subject: "feat: long", body: "one\ntwo\nthree\nfour\nfive", files: ["a.ts"] }],
	});
	const [collapsed] = render(long, idle, plain, 80);
	assert.match(collapsed, /^ {2}│ one\n {2}│ two\n {2}│ three …$/m, "three lines, the last one marked");
	assert.doesNotMatch(collapsed, /four/);

	const [expanded] = render({ ...long, expanded: 0 }, idle, plain, 80);
	assert.match(expanded, /^ {2}│ five$/m, "expanding shows the rest, unmarked");
	assert.doesNotMatch(expanded, /…/);
});

test("the hint line is contextual", () => {
	const start = initialState(plan);
	assert.match(render(start, idle, plain, 80)[1], /space expand · e subject · b write body/);
	assert.match(render(press(start, "space"), idle, plain, 80)[1], /b write body/);
	assert.doesNotMatch(render(press(start, "space"), idle, plain, 80)[1], /x drop body/);
	assert.match(render(press(start, "down", "space"), idle, plain, 80)[1], /x drop body/);
	assert.match(render(press(start, "down", "space"), idle, plain, 80)[1], /b edit body/);

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
	for (const name of ["b", "g", "x"]) {
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

	const [writing] = reduce(press(initialState(plan), "down", "space"), key("b"), idle);
	const [next, effect] = reduce(writing, key("q"), { text: "unsaved words", column: 13 });
	assert.equal(next, writing, "q types a letter instead of cancelling the review");
	assert.deepEqual(effect, { type: "none" });
	assert.equal(next.commits[1]?.body, "Because the pairing is lost.", "nothing is saved yet");
});

test("backspace at the very start of the body does nothing", () => {
	const [writing] = reduce(press(initialState(plan), "down", "space"), key("b"), idle);
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

test("content ends on the edited subject line, whole and prefixed", () => {
	const [editing] = reduce(initialState(plan), key("e"), idle);
	const text = "feat(cli): add the list";

	for (const column of [0, 7, text.length]) {
		const [content, bottom] = render(editing, { text, column }, plain, 80);
		const where = `column ${column}`;
		assert.equal(content.split("\n").pop(), `❯ ${text}`, `${where}: the live line ends the content, whole`);
		assert.equal(promptOf(content, text), "❯ ", `${where}: inquirer recovers the row prefix`);
		assert.doesNotMatch(content, /keep renames together/, `${where}: later rows sit below the cursor`);
		assert.match(bottom, /src\/cli\.ts/, `${where}: the file line of the edited row moved down`);
		assert.match(bottom, /keep renames together/, `${where}: so did the rest of the list`);
		assert.match(bottom, /↵ save/, `${where}: the hint stays last`);
	}
});

test("content ends on the edited body line, with the rest of the buffer below it", () => {
	const [editing] = reduce(press(initialState(plan), "down", "space"), key("b"), idle);
	const [split] = reduce(editing, key("return"), { text: "first second", column: 5 });
	const text = " second";

	for (const column of [0, 3, text.length]) {
		const [content, bottom] = render(split, { text, column }, plain, 80);
		const where = `column ${column}`;
		assert.equal(content.split("\n").pop(), `  │ ${text}`, `${where}: the live line ends the content, whole`);
		assert.equal(promptOf(content, text), "  │ ", `${where}: inquirer recovers the row prefix`);
		assert.match(content, /│ first/, `${where}: the rows above the cursor stay in the content`);
		assert.match(bottom, /src\/git\.ts/, `${where}: the file line moved down`);
		assert.match(bottom, /esc save/, `${where}: the hint stays last`);
	}

	const [back] = reduce(split, key("up"), { text, column: 0 });
	const [content, bottom] = render(back, { text: "first", column: 2 }, plain, 80);
	assert.equal(content.split("\n").pop(), "  │ first", "editing row 0 ends the content there");
	assert.equal(bottom.split("\n")[0], `  │ ${text}`, "the rows below the cursor lead the bottom content");
});

test("the fallback banner names the reason once", () => {
	const reported = initialState({
		commits: plan.commits,
		fallback: true,
		failureReason: "the provider ran out of time",
	});
	assert.match(render(reported, idle, plain, 80)[0], /^! local fallback: the provider ran out of time$/m);

	const silent = initialState({ commits: plan.commits, fallback: true });
	assert.match(render(silent, idle, plain, 80)[0], /^! local fallback: the provider did not return a plan$/m);
});

test("escape in the body editor saves what was typed", () => {
	const [writing] = reduce(press(initialState(plan), "down", "space"), key("b"), idle);
	const [saved, effect] = reduce(writing, key("escape"), { text: "half a thought", column: 14 });
	assert.equal(saved.mode, "list");
	assert.equal(saved.buffer, null);
	assert.equal(saved.expanded, 1, "the row stays expanded");
	assert.equal(saved.commits[1]?.body, "half a thought");
	assert.deepEqual(effect, { type: "none" });
});

test("ctrl+e in the body editor banks what was typed", () => {
	const [writing] = reduce(press(initialState(plan), "down", "space"), key("b"), idle);
	const [next, effect] = reduce(writing, key("e", true), { text: "typed but not saved", column: 19 });
	assert.deepEqual(effect, { type: "editor", index: 1 });
	assert.deepEqual(next.buffer, { lines: ["typed but not saved"], row: 0 }, "the external editor sees the live line");
});

test("the editor helpers keep the pure message rules out of the shell", () => {
	assert.equal(editorSeed("feat: one", ""), "feat: one");
	assert.equal(editorSeed("feat: one", "  \n "), "feat: one", "a blank body adds no separator");
	assert.equal(editorSeed("feat: one", "why"), "feat: one\n\nwhy");

	assert.equal(parseEditedMessage(""), null);
	assert.equal(parseEditedMessage("   \n\nwhy"), null, "an empty subject is refused");
	assert.deepEqual(parseEditedMessage("  feat: one  "), { subject: "feat: one", body: "" });
	assert.deepEqual(parseEditedMessage("feat: one\r\n\r\nwhy\r\nand how\r\n"), {
		subject: "feat: one",
		body: "why\nand how",
	});
});

/**
 * The bytes a terminal sends for the keys the review binds. Escape costs real time: readline decodes
 * a lone escape only after its half-second timeout, so a `wait` has to follow it, which is why only
 * the generation test presses it.
 */
const BYTES: Record<string, string> = {
	escape: "\u001b",
	up: "\u001b[A",
	down: "\u001b[B",
	left: "\u001b[D",
	space: " ",
	enter: "\r",
	backspace: "\u007f",
	ctrld: "\u0004",
	ctrlu: "\u0015",
};

/** The move the screen manager writes last: an optional row climb, then an absolute column. */
const CURSOR = /\u001b\[(?:(\d+)A)?\u001b\[(\d+)G$/;

/**
 * Drive the prompt through the same `input` and `output` context options a terminal would fill, and
 * report each frame as the rows it drew plus the row and column it left the cursor on.
 */
function drive(source: CommitPlan, onGenerate?: ReviewConfig["onGenerate"]) {
	const input = new PassThrough();
	const output = new PassThrough();
	let drawn = "";
	output.on("data", (data: Buffer) => {
		drawn += data.toString();
	});
	const result = reviewCommits({ plan: source, ...(onGenerate ? { onGenerate } : {}) }, { input, output });

	/** Everything drawn since the last read, as rows plus where the cursor was left. */
	function frame() {
		const raw = drawn;
		drawn = "";
		const match = CURSOR.exec(raw);
		const lines = stripVTControlCharacters(raw.replace(CURSOR, "")).replace(/^\n+/, "").split("\n");
		return { lines, row: lines.length - 1 - Number(match?.[1] ?? 0), column: Number(match?.[2] ?? 1) - 1 };
	}

	// One tick before the keys as well: the first frame is deferred so readline can drain whatever
	// the stream had buffered before any handler was listening.
	async function send(...keys: string[]) {
		await new Promise((resolve) => setImmediate(resolve));
		for (const name of keys) {
			input.write(BYTES[name] ?? name);
			await new Promise((resolve) => setImmediate(resolve));
		}
		return frame();
	}

	/** Let real time pass, for the escape timeout and for callbacks that settle off a keypress. */
	async function wait(ms: number) {
		await new Promise((resolve) => setTimeout(resolve, ms));
		await new Promise((resolve) => setImmediate(resolve));
		return frame();
	}

	return { result, send, wait };
}

test("the prompt draws, navigates and edits a body against a synthetic terminal", { timeout: 5000 }, async () => {
	const terminal = drive(plan);
	const first = await terminal.send();
	assert.match(first.lines.join("\n"), /^❯ feat\(cli\): add the list$/m, "the first row starts selected");

	const moved = await terminal.send("down");
	const movedText = moved.lines.join("\n");
	assert.match(movedText, /^❯ fix\(git\): keep renames together$/m, "the marker moved");
	assert.match(movedText, /^ {2}│ Because the pairing is lost\.$/m, "a collapsed row previews its body");
	assert.doesNotMatch(movedText, /^❯ feat\(cli\)/m);

	const box = await terminal.send("b");
	assert.equal(box.lines[box.row], "  │ Because the pairing is lost.", "the caret sits on the body row itself");
	assert.equal(box.column, "  │ Because the pairing is lost.".length, "at the end of what was drawn there");
	assert.match(box.lines.join("\n"), /esc save/, "b opened the box from the collapsed row");

	const typed = await terminal.send("left", "!");
	assert.equal(typed.lines[typed.row], "  │ Because the pairing is lost!.", "typing inserts at the caret");
	assert.equal(typed.column, "  │ Because the pairing is lost!".length, "which the caret then follows");

	await terminal.send("escape");
	const saved = await terminal.wait(700);
	assert.match(saved.lines.join("\n"), /space collapse/, "esc closes the box on an expanded row");

	await terminal.send("enter");
	const { outcome, commits } = await terminal.result;
	assert.equal(outcome, "commit");
	assert.equal(commits[1]?.body, "Because the pairing is lost!.");
	assert.equal(plan.commits[1]?.body, "Because the pairing is lost.", "the caller's plan is untouched");
});

test("ctrl+d never reaches readline as end of input", { timeout: 5000 }, async () => {
	// readline closes itself on ctrl+d with an empty line, and the review's line is empty on every
	// list frame. An undefended prompt stops drawing here and its promise never settles.
	const list = drive(plan);
	await list.send();
	await list.send("ctrld");
	assert.match((await list.send("down")).lines.join("\n"), /^❯ fix\(git\)/m, "the list still answers keys");
	await list.send("q");
	assert.equal((await list.result).outcome, "cancel");

	// The subject editor reaches the same empty line the moment ctrl+u clears it.
	const subject = drive(plan);
	await subject.send();
	await subject.send("e", "ctrlu", "ctrld");
	assert.match((await subject.send("enter")).lines.join("\n"), /↵ save/, "the subject editor survives it too");
	await subject.send("feat: kept", "enter", "q");
	assert.equal((await subject.result).outcome, "cancel");
});

test("an empty subject keeps the editor open", { timeout: 5000 }, async () => {
	const terminal = drive(plan);
	await terminal.send();

	const rejected = await terminal.send("e", "ctrlu", "enter");
	const text = rejected.lines.join("\n");
	assert.match(text, /A commit subject cannot be empty\./);
	assert.match(text, /↵ save · esc cancel/, "the editor is still open");
	assert.equal(rejected.column, "❯ ".length, "with the caret on the emptied row");

	const accepted = await terminal.send("feat: renamed", "enter");
	assert.match(accepted.lines.join("\n"), /^❯ feat: renamed$/m);

	await terminal.send("enter");
	const { outcome, commits } = await terminal.result;
	assert.equal(outcome, "commit");
	assert.equal(commits[0]?.subject, "feat: renamed");
});

/**
 * The one path that cannot be reached through `reduce` alone: the shell's generation continuation.
 * It resolves after further keypresses, and `useState`'s setter takes a value rather than an
 * updater, so a callback that closed over the state it was created with would write back a snapshot
 * from before those keypresses. Every assertion about where the selection ends up is therefore a
 * test of the `latest` ref rather than of navigation.
 */
test(
	"g generates a body, esc aborts it, and neither write clobbers what changed meanwhile",
	{ timeout: 20_000 },
	async () => {
		const asked: string[] = [];
		let release: ((body: string) => void) | null = null;
		let refuse: ((error: Error) => void) | null = null;
		const terminal = drive(plan, (index, subject, signal) => {
			asked.push(`${index}:${subject}`);
			return new Promise<string>((resolve, reject) => {
				release = resolve;
				refuse = reject;
				signal.addEventListener("abort", () => reject(signal.reason as Error));
			});
		});
		await terminal.send();

		// A subject edited in the list, to prove the generator is handed that one and not the plan's.
		await terminal.send("e", "ctrlu", "feat(cli): edited here", "enter");

		const started = await terminal.send("space", "g");
		assert.match(started.lines.join("\n"), /writing body…/, "the row says what it is doing");
		assert.match(started.lines.join("\n"), /esc cancel generation/, "and the hint says how to stop it");
		assert.deepEqual(asked, ["0:feat(cli): edited here"], "the live subject is what was sent");

		// Navigation stays live while the request is out, and collapses row 0 on the way.
		const moved = await terminal.send("down");
		assert.match(moved.lines.join("\n"), /^❯ fix\(git\): keep renames together$/m, "↓ still moves");
		assert.match(moved.lines.join("\n"), /writing body…/, "row 0 keeps its marker after the selection left it");

		const expanded = await terminal.send("space");
		assert.match(expanded.lines.join("\n"), /^ {2}│ Because the pairing is lost\.$/m, "space still expands");

		for (const name of ["e", "b", "x", "r", "enter"]) {
			assert.deepEqual((await terminal.send(name)).lines, expanded.lines, `${name} changes nothing mid-generation`);
		}

		await terminal.send("escape");
		const aborted = await terminal.wait(700);
		const abortedText = aborted.lines.join("\n");
		assert.doesNotMatch(abortedText, /writing body…/, "the marker is gone");
		assert.doesNotMatch(abortedText, /Could not write a body/, "an abort the user asked for reports nothing");
		assert.match(abortedText, /^ {2}feat\(cli\): edited here\n {4}src\/cli\.ts/m, "row 0 was left without a body");
		assert.match(abortedText, /^❯ fix\(git\): keep renames together$/m, "the selection stayed where it moved to");
		assert.match(abortedText, /^ {2}│ Because the pairing is lost\.$/m, "so did the expansion");
		assert.match(abortedText, /x drop body/, "and the hint is the expanded-row one again");

		// Second attempt, on the row the selection moved to, released while the selection is elsewhere.
		await terminal.send("g");
		assert.deepEqual(asked[1], "1:fix(git): keep renames together");
		await terminal.send("up");
		release!("A body the model wrote.");
		const written = await terminal.wait(20);
		const writtenText = written.lines.join("\n");
		assert.match(writtenText, /^❯ feat\(cli\): edited here$/m, "the move made during the request survived the write");
		assert.match(
			writtenText,
			/^ {2}fix\(git\): keep renames together\n {2}│ A body the model wrote\.$/m,
			"the body landed on its own row"
		);
		assert.doesNotMatch(writtenText, /writing body…/);

		// A generator that refuses says so on the row and leaves the body that was already there.
		// generateCommitBody rejects rather than answering with an empty string for exactly this reason.
		await terminal.send("down", "space", "g");
		refuse!(new Error("the model had nothing to add beyond the subject"));
		const refused = await terminal.wait(20);
		const refusedText = refused.lines.join("\n");
		// The reason alone: an "Error:" prefix would read as a provider crash rather than as an answer.
		assert.match(refusedText, /Could not write a body: the model had nothing to add beyond the subject/);
		assert.doesNotMatch(refusedText, /Could not write a body: Error/);
		assert.match(refusedText, /^ {2}│ A body the model wrote\.$/m, "the body that was there survived");
		assert.doesNotMatch(refusedText, /writing body…/);

		// q leaves from anywhere, including with a request still out.
		await terminal.send("g");
		assert.equal(asked.length, 4);
		await terminal.send("q");
		const { outcome, commits } = await terminal.result;
		assert.equal(outcome, "cancel", "q cancels the review mid-generation");
		assert.equal(commits[1]?.body, "A body the model wrote.");
		assert.equal(plan.commits[1]?.body, "Because the pairing is lost.", "the caller's plan is untouched");
	}
);
