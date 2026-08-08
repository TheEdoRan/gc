import { createPrompt, useEffect, useKeypress, useRef, useState } from "@inquirer/core";
import { editAsync } from "@inquirer/external-editor";

import type { CommitPlan, ProposedCommit } from "./ai.ts";
import { createTerminal, paint, type Terminal } from "./terminal.ts";
import {
	activeLine,
	fromText,
	joinPrevious,
	moveRow,
	setLine,
	splitLine,
	toText,
	type TextBuffer,
} from "./textarea.ts";

export type ReviewMode = "list" | "subject" | "body";
export type ReviewOutcome = "commit" | "regenerate" | "cancel";

export interface ReviewState {
	commits: ProposedCommit[];
	index: number;
	/** The one row showing its body and its full file list, or null. */
	expanded: number | null;
	mode: ReviewMode;
	/** The body being edited, or null outside body mode. */
	buffer: TextBuffer | null;
	/** The row whose body the model is writing, or null. At most one at a time. */
	generating: number | null;
	error: string | null;
	notice: string;
	fallback: string;
	done: ReviewOutcome | null;
}

export interface ReviewKey {
	name: string;
	ctrl: boolean;
	shift: boolean;
}

/** What the shell must do that the state alone cannot express. */
export type ReviewEffect =
	| { type: "none" }
	| { type: "generate"; index: number }
	| { type: "abort" }
	| { type: "editor"; index: number }
	/** Push this text into readline and put the cursor at `column`. */
	| { type: "load"; text: string; column: number };

/** Readline's live line and cursor. The state never stores them, so it stays pure. */
export interface Live {
	text: string;
	column: number;
}

const NONE: ReviewEffect = { type: "none" };

export function initialState(plan: CommitPlan): ReviewState {
	return {
		// Copied, so cancelling leaves the caller's plan untouched.
		commits: plan.commits.map((commit) => ({ ...commit, files: [...commit.files] })),
		index: 0,
		expanded: null,
		mode: "list",
		buffer: null,
		generating: null,
		error: null,
		notice: plan.notice ?? "",
		fallback: plan.fallback ? plan.failureReason || "the provider did not return a plan" : "",
		done: null,
	};
}

function commitAt(state: ReviewState, index = state.index): ProposedCommit | undefined {
	return state.commits[index];
}

/** Replace one commit without mutating the array the caller still holds. */
function withCommit(state: ReviewState, index: number, patch: Partial<ProposedCommit>): ReviewState {
	const current = state.commits[index];
	if (!current) return state;
	return { ...state, commits: state.commits.toSpliced(index, 1, { ...current, ...patch }), error: null };
}

function reduceSubject(state: ReviewState, key: ReviewKey, live: Live): [ReviewState, ReviewEffect] {
	if (key.name === "escape") return [{ ...state, mode: "list", error: null }, NONE];
	if (key.name !== "return") return [state, NONE];
	if (!live.text.trim()) return [{ ...state, error: "A commit subject cannot be empty." }, NONE];
	return [{ ...withCommit(state, state.index, { subject: live.text.trim() }), mode: "list" }, NONE];
}

function reduceBody(state: ReviewState, key: ReviewKey, live: Live): [ReviewState, ReviewEffect] {
	const buffer = state.buffer;
	if (!buffer) return [{ ...state, mode: "list" }, NONE];

	if (key.name === "escape") return [{ ...state, mode: "list", buffer: null, error: null }, NONE];

	if (key.ctrl && key.name === "d") {
		const text = toText(setLine(buffer, live.text)).trim();
		return [{ ...withCommit(state, state.index, { body: text }), mode: "list", buffer: null }, NONE];
	}

	// The live line is banked first, so the external editor is seeded with what is on screen.
	if (key.ctrl && key.name === "e") {
		return [
			{ ...state, buffer: setLine(buffer, live.text) },
			{ type: "editor", index: state.index },
		];
	}

	if (key.name === "return") {
		const next = splitLine(setLine(buffer, live.text), live.text, live.column);
		return [
			{ ...state, buffer: next },
			{ type: "load", text: activeLine(next), column: 0 },
		];
	}

	if (key.name === "backspace" && live.column === 0) {
		const saved = setLine(buffer, live.text);
		const { buffer: next, column } = joinPrevious(saved, live.text);
		// joinPrevious hands back the same object on the first row, which is how "nothing joined" reads.
		if (next === saved) return [{ ...state, buffer: saved }, NONE];
		return [
			{ ...state, buffer: next },
			{ type: "load", text: activeLine(next), column },
		];
	}

	if (key.name === "up" || key.name === "down") {
		const saved = setLine(buffer, live.text);
		const next = moveRow(saved, key.name === "up" ? -1 : 1);
		if (next === saved) return [{ ...state, buffer: saved }, NONE];
		return [
			{ ...state, buffer: next },
			{ type: "load", text: activeLine(next), column: activeLine(next).length },
		];
	}

	// Any other key is readline's business: it edits the live line and render picks it up.
	return [state, NONE];
}

export function reduce(state: ReviewState, key: ReviewKey, live: Live): [ReviewState, ReviewEffect] {
	if (state.mode === "subject") return reduceSubject(state, key, live);
	if (state.mode === "body") return reduceBody(state, key, live);

	// q always leaves, so there is a way out even mid-generation.
	if (key.name === "q") return [{ ...state, done: "cancel" }, state.generating === null ? NONE : { type: "abort" }];

	// esc is modal: it stops a running generation first, and only cancels the review once none runs.
	if (key.name === "escape") {
		return state.generating === null ? [{ ...state, done: "cancel" }, NONE] : [state, { type: "abort" }];
	}

	if (key.name === "up" || key.name === "k" || key.name === "down" || key.name === "j") {
		const delta = key.name === "up" || key.name === "k" ? -1 : 1;
		const index = Math.max(Math.min(state.index + delta, state.commits.length - 1), 0);
		if (index === state.index) return [state, NONE];
		// Moving collapses, so exactly one row is ever expanded.
		return [{ ...state, index, expanded: null, error: null }, NONE];
	}

	if (key.name === "space") {
		return [{ ...state, expanded: state.expanded === state.index ? null : state.index, error: null }, NONE];
	}

	// Everything below changes the plan, so none of it may run while the model is writing a body.
	if (state.generating !== null) return [state, NONE];

	if (key.ctrl && key.name === "e") return [state, { type: "editor", index: state.index }];
	if (key.name === "return") return [{ ...state, done: "commit" }, NONE];
	if (key.name === "r") return [{ ...state, done: "regenerate" }, NONE];

	if (key.name === "e") {
		const subject = commitAt(state)?.subject ?? "";
		return [
			{ ...state, mode: "subject", error: null },
			{ type: "load", text: subject, column: subject.length },
		];
	}

	// Body actions live in the expanded view only, which is what keeps the collapsed list short.
	if (state.expanded !== state.index) return [state, NONE];

	if (key.name === "i") {
		const body = commitAt(state)?.body ?? "";
		const buffer = fromText(body);
		return [
			{ ...state, mode: "body", buffer, error: null },
			{ type: "load", text: activeLine(buffer), column: activeLine(buffer).length },
		];
	}

	if (key.name === "g") return [state, { type: "generate", index: state.index }];

	if (key.name === "x") {
		if (!commitAt(state)?.body) return [state, NONE];
		return [withCommit(state, state.index, { body: "" }), NONE];
	}

	return [state, NONE];
}

/** The commit-message text the external editor is opened on. */
export function editorSeed(subject: string, body: string): string {
	return body.trim() ? `${subject}\n\n${body}` : subject;
}

/**
 * Read back what the external editor wrote: the first line is the subject and the rest is the body.
 * Null when the subject is empty, which is the one message Git will not take.
 */
export function parseEditedMessage(text: string): { subject: string; body: string } | null {
	const [subject = "", ...rest] = text.replace(/\r\n/g, "\n").split("\n");
	if (!subject.trim()) return null;
	return { subject: subject.trim(), body: rest.join("\n").trim() };
}

const TYPE_STYLES: Record<string, "green" | "yellow" | "blue" | "magenta"> = {
	feat: "green",
	fix: "yellow",
	docs: "blue",
};
const CONVENTIONAL = /^([a-z]+)(\([^)]*\))?(!?:\s)(.*)$/;
const COLLAPSED_FILES = 3;

/** Colour the Conventional Commit type. A subject in any other shape is left alone. */
function paintSubject(terminal: Terminal, subject: string): string {
	const match = CONVENTIONAL.exec(subject);
	if (!match) return subject;
	const [, type = "", scope = "", separator = "", rest = ""] = match;
	const style = TYPE_STYLES[type] ?? "magenta";
	return `${paint(terminal, style, type)}${paint(terminal, "dim", scope)}${separator}${rest}`;
}

/** Break `text` into lines no wider than `width`, at spaces where possible. */
function wrap(text: string, width: number): string[] {
	const output: string[] = [];
	for (const paragraph of text.split("\n")) {
		let line = "";
		for (const word of paragraph.split(" ")) {
			if (line && line.length + 1 + word.length > width) {
				output.push(line);
				line = word;
			} else {
				line = line ? `${line} ${word}` : word;
			}
		}
		output.push(line);
	}
	return output;
}

function hint(state: ReviewState): string {
	if (state.generating !== null) return "↑↓ move · space expand · esc cancel generation · q cancel";
	if (state.mode === "subject") return "↵ save · esc cancel";
	if (state.mode === "body") return "↵ newline · ctrl+d save · ctrl+e editor · esc cancel";
	if (state.expanded !== state.index) {
		return "↑↓ move · space expand · e subject · ctrl+e editor · r regen · ↵ commit · q cancel";
	}
	const body = state.commits[state.index]?.body;
	const drop = body ? " · x drop body" : "";
	return `space collapse · ${body ? "i edit body" : "i write body"} · g generate body${drop} · ctrl+e editor`;
}

/**
 * Returns `[content, bottom]`.
 *
 * Inquirer's screen manager takes the LAST line of `content` as the prompt line, strips
 * `rl.line.length` characters off its end to recover the prefix, and puts the terminal cursor at
 * that prefix width plus `rl.cursor`. So the whole live line belongs at the end of `content`, the
 * prefix in front of it must be exactly what the row is indented with, and every line below the
 * cursor row belongs in `bottom`, which the screen manager writes after a newline of its own.
 */
export function render(state: ReviewState, live: Live, terminal: Terminal, width: number): [string, string] {
	const body = Math.max(20, width - 6);
	const files = state.commits.reduce((total, commit) => total + commit.files.length, 0);
	const lines: string[] = [];

	if (state.fallback) {
		lines.push(paint(terminal, "red", `! local fallback: ${state.fallback}`));
	}
	lines.push(
		`  ${state.commits.length} commit${state.commits.length === 1 ? "" : "s"} · ${files} file${files === 1 ? "" : "s"}`
	);
	if (state.notice) lines.push(paint(terminal, "dim", `  ${state.notice}`));
	lines.push("");

	// The row the terminal cursor belongs on, or -1 when no editor is open.
	let cursorLine = -1;
	for (const [index, commit] of state.commits.entries()) {
		const selected = index === state.index;
		const expanded = state.expanded === index;
		const marker = selected ? paint(terminal, "cyan", "❯") : " ";

		if (selected && state.mode === "subject") {
			cursorLine = lines.length;
			lines.push(`${marker} ${live.text}`);
		} else {
			const rows = commit.body.split("\n").length;
			const badge = !expanded && commit.body ? paint(terminal, "dim", `  ¶ ${rows} line${rows === 1 ? "" : "s"}`) : "";
			lines.push(`${marker} ${paintSubject(terminal, commit.subject)}${badge}`);
		}

		// Not gated on the selection: navigation stays live during a generation, so the row being
		// written is often not the selected one.
		if (state.generating === index) {
			lines.push(paint(terminal, "dim", "    writing body…"));
		} else if (expanded && state.mode === "body" && state.buffer) {
			const buffer = state.buffer;
			for (const text of buffer.lines.slice(0, buffer.row)) lines.push(paint(terminal, "dim", `  │ ${text}`));
			cursorLine = lines.length;
			lines.push(`  ${paint(terminal, "dim", "│")} ${live.text}`);
			for (const text of buffer.lines.slice(buffer.row + 1)) lines.push(paint(terminal, "dim", `  │ ${text}`));
		} else if (expanded) {
			const text = commit.body || "No body for this commit";
			for (const line of wrap(text, body)) lines.push(paint(terminal, "dim", `  │ ${line}`));
		}

		const shown = expanded ? commit.files : commit.files.slice(0, COLLAPSED_FILES);
		const more = commit.files.length - shown.length;
		lines.push(paint(terminal, "dim", `    ${shown.join("  ")}${more > 0 ? `  +${more} more` : ""}`));
		lines.push("");
	}

	if (state.error) lines.push(paint(terminal, "red", `  ${state.error}`));
	const footer = paint(terminal, "dim", `  ${hint(state)}`);

	// Content has to end on the cursor row, so everything below it becomes bottom content.
	if (cursorLine < 0) return [lines.join("\n"), footer];
	return [lines.slice(0, cursorLine + 1).join("\n"), [...lines.slice(cursorLine + 1), footer].join("\n")];
}

/**
 * readline owns the live line, but `InquirerReadline` declares neither the cursor column nor that
 * both are writable, and `readline.Interface` marks them readonly.
 */
interface RawReadline {
	line: string;
	cursor: number;
	history: string[];
	pause: () => void;
	resume: () => void;
}

const EMPTY_LIVE: Live = { text: "", column: 0 };

/**
 * True when the review binds the key itself, so readline's reaction to it has to be undone.
 *
 * readline runs first and it does not know it is being driven: `return` empties the line, `ctrl+d`
 * deletes the character to the right, `ctrl+e` jumps to the end, and `up`/`down` walk its history.
 * For these the live line comes from state and readline is put back where the last frame left it.
 * Everything else, including plain typing and `backspace` past column 0, is readline's to own.
 */
function isClaimed(mode: ReviewMode, key: ReviewKey): boolean {
	if (mode === "list") return true;
	if (key.ctrl) return key.name === "d" || key.name === "e";
	if (key.name === "return" || key.name === "escape") return true;
	return mode === "body" && (key.name === "up" || key.name === "down");
}

/**
 * The only place readline's line is written.
 *
 * The screen manager recovers the prompt prefix with `lastLine(content).slice(0, -rl.line.length)`
 * and then measures `prefix + line.slice(0, cursor)` to place the terminal cursor. That lands on
 * the right column only while readline holds exactly the live line `render` draws, so every path
 * through the keypress handler passes through here.
 */
function sync(rl: RawReadline, live: Live): Live {
	rl.line = live.text;
	rl.cursor = live.column;
	return live;
}

export interface ReviewConfig {
	plan: CommitPlan;
	/**
	 * Ask the model for a body. Absent until the generator exists. The subject is passed in rather
	 * than read from the caller's plan, so a subject edited in the list is the one that is sent.
	 */
	onGenerate?: (index: number, subject: string, signal: AbortSignal) => Promise<string>;
}

export interface ReviewResult {
	outcome: ReviewOutcome;
	commits: ProposedCommit[];
}

export const reviewCommits = createPrompt<ReviewResult, ReviewConfig>((config, done) => {
	const terminal = createTerminal(process.stdout);
	const [state, setState] = useState(() => initialState(config.plan));
	const [live, setLive] = useState<Live>(EMPTY_LIVE);
	const [controller, setController] = useState<AbortController | null>(null);
	// `useState`'s setter takes a value, not an updater, so callbacks that resolve after further
	// keypresses read the newest state from here instead of closing over a stale one.
	const latest = useRef(state);
	latest.current = state;

	useEffect(() => {
		if (state.done) done({ outcome: state.done, commits: state.commits });
	}, [state.done]);

	// readline reads ctrl+d on an empty line as end of input and closes itself, which freezes the
	// prompt: no further frame is drawn and the promise never settles. The line is empty on every
	// list frame and can be emptied in either editor, so close is disarmed for the whole prompt
	// rather than for one mode. The teardown path is untouched, because @inquirer/core clears the
	// hooks, and so runs this cleanup, before the screen manager closes the interface for real.
	useEffect((rl) => {
		const close = rl.close.bind(rl);
		rl.close = () => {};
		return () => {
			rl.close = close;
		};
	}, []);

	useKeypress((key, readline) => {
		const rl = readline as unknown as RawReadline;

		// Return in the body box is a newline, not a submission, but readline still files every one
		// of them in its history, where up and down could recall one into an unrelated line.
		rl.history.length = 0;

		const echoed = state.mode === "list" && rl.line.length > 0;
		const current = sync(rl, isClaimed(state.mode, key) ? live : { text: rl.line, column: rl.cursor });

		const [next, effect] = reduce(state, key, current);
		let final = next;
		const target: Live = effect.type === "load" ? { text: effect.text, column: effect.column } : current;

		if (effect.type === "abort") controller?.abort();

		if (effect.type === "editor") {
			const commit = next.commits[effect.index];
			// The buffer, not the commit, holds the body while the box is open: reduce banked the
			// live line into it before asking for the editor.
			const body = next.buffer ? toText(next.buffer) : (commit?.body ?? "");
			// readline has to let go of the terminal while the child owns it. External-editor
			// restores raw mode on exit, and the box stays open behind it: it closes on success
			// only, so a child that never starts does not take what was typed with it.
			rl.pause();
			void editAsync(commit ? editorSeed(commit.subject, body) : "", { postfix: ".txt" })
				.then(
					(edited) => {
						const message = parseEditedMessage(edited);
						if (!message) {
							setState({ ...latest.current, error: "A commit subject cannot be empty." });
							return;
						}
						setLive(sync(rl, EMPTY_LIVE));
						setState({ ...withCommit(latest.current, effect.index, message), mode: "list", buffer: null });
					},
					(error: unknown) => setState({ ...latest.current, error: `Editor failed: ${String(error)}` })
				)
				.finally(() => rl.resume());
		}

		if (effect.type === "generate") {
			if (!config.onGenerate) {
				final = { ...next, error: "Body generation is not available yet." };
			} else {
				const abort = new AbortController();
				setController(abort);
				final = { ...next, generating: effect.index, error: null };
				void config
					.onGenerate(effect.index, next.commits[effect.index]?.subject ?? "", abort.signal)
					.then(
						(body) => setState({ ...withCommit(latest.current, effect.index, { body }), generating: null }),
						(error: unknown) =>
							setState({
								...latest.current,
								generating: null,
								error: abort.signal.aborted ? null : `Could not write a body: ${String(error)}`,
							})
					)
					.finally(() => setController(null));
			}
		}

		setState(final);
		// An echoed key already made the screen manager move the terminal cursor, so clearing the
		// line is not enough: a fresh object forces the redraw that puts it back.
		setLive(sync(rl, final.mode === "list" ? (echoed ? { text: "", column: 0 } : EMPTY_LIVE) : target));
	});

	return render(state, live, terminal, process.stdout.columns || 80);
});
