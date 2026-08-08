/**
 * A list of lines and which one is active. Readline owns everything inside a line: the cursor,
 * backspace, delete, home, end, word delete, and multi-byte characters. This module owns only the
 * moves between lines, so it stays pure and testable without a terminal.
 *
 * Callers pass the live line text in from `rl.line` rather than reading it from the buffer, because
 * readline holds the edits that have not been committed to a row yet.
 */
export interface TextBuffer {
	lines: string[];
	row: number;
}

export function fromText(text: string): TextBuffer {
	return { lines: text.replace(/\r\n/g, "\n").split("\n"), row: 0 };
}

export function toText(buffer: TextBuffer): string {
	return buffer.lines.join("\n");
}

export function activeLine(buffer: TextBuffer): string {
	return buffer.lines[buffer.row] ?? "";
}

function replace(buffer: TextBuffer, row: number, ...lines: string[]): string[] {
	return buffer.lines.toSpliced(row, 1, ...lines);
}

export function setLine(buffer: TextBuffer, text: string): TextBuffer {
	return { lines: replace(buffer, buffer.row, text), row: buffer.row };
}

/** Cut the active line at `column` and make the remainder the next line. */
export function splitLine(buffer: TextBuffer, text: string, column: number): TextBuffer {
	return { lines: replace(buffer, buffer.row, text.slice(0, column), text.slice(column)), row: buffer.row + 1 };
}

/**
 * Merge the active line into the one above it, reporting where the join happened so the caller can
 * put readline's cursor back at the seam. A no-op on the first row.
 */
export function joinPrevious(buffer: TextBuffer, text: string): { buffer: TextBuffer; column: number } {
	if (buffer.row === 0) return { buffer, column: 0 };
	const above = buffer.lines[buffer.row - 1] ?? "";
	const lines = buffer.lines.toSpliced(buffer.row - 1, 2, above + text);
	return { buffer: { lines, row: buffer.row - 1 }, column: above.length };
}

export function moveRow(buffer: TextBuffer, delta: number): TextBuffer {
	const row = Math.min(Math.max(buffer.row + delta, 0), buffer.lines.length - 1);
	return row === buffer.row ? buffer : { lines: buffer.lines, row };
}
