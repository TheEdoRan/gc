import { styleText } from "node:util";

export type Style = Parameters<typeof styleText>[0];

export interface Terminal {
	stream: NodeJS.WritableStream;
	/** True when escape sequences may be written. */
	color: boolean;
	/** True when the region may be redrawn in place. */
	interactive: boolean;
}

/**
 * Color is off whenever the region cannot be redrawn, and off whenever NO_COLOR is present at any
 * value, which is what the NO_COLOR convention asks for.
 */
export function createTerminal(
	stream: NodeJS.WritableStream & { isTTY?: boolean } = process.stderr,
	env: NodeJS.ProcessEnv = process.env
): Terminal {
	const interactive = Boolean(stream.isTTY);
	return { stream, interactive, color: interactive && env.NO_COLOR === undefined };
}

export function paint(terminal: Terminal, style: Style, text: string): string {
	// validateStream is off because styleText otherwise re-checks process.stdout, which is not
	// necessarily terminal.stream: createTerminal defaults to stderr, and tests pass a PassThrough.
	return terminal.color ? styleText(style, text, { validateStream: false }) : text;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;

export function frameAt(tick: number): string {
	return FRAMES[((tick % FRAMES.length) + FRAMES.length) % FRAMES.length]!;
}

/** Move to the start of the line `count` above, then erase everything below it. */
function eraseLines(count: number): string {
	return count > 0 ? `\u001b[${count}F\u001b[0J` : "";
}

const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";

export interface Spinner {
	/** Replace the headline, for example "waiting for the model" or "writing plan". */
	phase(label: string): void;
	/** Set the streamed subject at `index`. Ignored when the region cannot be redrawn. */
	subject(index: number, text: string): void;
	/** Write a line that stays in the scrollback above the spinner. */
	note(text: string): void;
	stop(): void;
}

export function createSpinner(terminal: Terminal, model: string): Spinner {
	const started = Date.now();
	const subjects: string[] = [];
	let label = "";
	let tick = 0;
	let drawn = 0;
	let timer: NodeJS.Timeout | undefined;

	function write(text: string) {
		terminal.stream.write(text);
	}

	function headline(): string {
		const seconds = Math.round((Date.now() - started) / 1000);
		return `${paint(terminal, "cyan", frameAt(tick))} ${model} ${paint(terminal, "dim", `· ${label} · ${seconds}s`)}`;
	}

	function draw() {
		const lines = [headline(), ...(subjects.length ? [""] : [])];
		// `entries()` walks holes as `undefined`, and a producer that reports index 1 before index 0
		// leaves one. An empty row is the honest rendering of a subject that has not arrived.
		for (const [index, subject] of subjects.entries()) {
			lines.push(`  ${paint(terminal, "dim", String(index + 1))}  ${subject ?? ""}`);
		}
		write(`${eraseLines(drawn)}${lines.join("\n")}\n`);
		drawn = lines.length;
	}

	function start() {
		if (timer || !terminal.interactive) return;
		write(HIDE_CURSOR);
		timer = setInterval(() => {
			tick++;
			draw();
		}, FRAME_MS);
		// Never hold the event loop open for a decoration.
		timer.unref();
		draw();
	}

	return {
		phase(next) {
			label = next;
			if (!terminal.interactive) {
				write(`${next}\n`);
				return;
			}
			start();
			draw();
		},
		subject(index, text) {
			if (!terminal.interactive) return;
			subjects[index] = text;
			start();
			draw();
		},
		note(text) {
			if (!terminal.interactive) {
				write(`${text}\n`);
				return;
			}
			// Erase the region, leave the note behind, then redraw below it.
			write(`${eraseLines(drawn)}${paint(terminal, "dim", text)}\n`);
			drawn = 0;
			draw();
		},
		stop() {
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
			if (!terminal.interactive) return;
			write(`${eraseLines(drawn)}${SHOW_CURSOR}`);
			drawn = 0;
		},
	};
}
