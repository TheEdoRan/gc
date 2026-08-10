import { spawn } from "node:child_process";

export interface RenamePair {
	from: string;
	to: string;
}

export interface StagedFile {
	/** Repo-relative POSIX path, taken from `--name-status -z` so it is never quoted or escaped. */
	path: string;
	/** Raw name-status letters: `A`, `M`, `D`, `T`, `R100`, `C75`, ... */
	status: string;
	/** `+` lines across the whole section, not just the retained head. `0` for binary files. */
	added: number;
	/** `-` lines across the whole section, not just the retained head. */
	deleted: number;
	/** Byte length of the entire diff section, before any truncation. */
	bytes: number;
	/** Retained prefix of the diff section. May be the whole section. */
	head: string;
	/** `true` when `head` is shorter than the full section. */
	truncated: boolean;
	/** `true` when git reported `Binary files ... differ`. */
	binary: boolean;
}

export interface RepositoryChanges {
	root: string;
	files: StagedFile[];
	paths: string[];
	renames: RenamePair[];
	history: string[];
}

export interface CommitGroup {
	subject: string;
	body?: string;
	files: string[];
}

export class GitError extends Error {
	readonly code: number | null;
	readonly stderr: string;

	constructor(message: string, code: number | null, stderr = "") {
		super(stderr.trim() ? `${message}: ${stderr.trim()}` : message);
		this.name = "GitError";
		this.code = code;
		this.stderr = stderr;
	}
}

interface GitResult {
	code: number;
	stdout: Buffer;
	stderr: Buffer;
}

async function git(
	args: string[],
	cwd: string,
	input?: Uint8Array,
	allowFailure = false,
	inherit = false
): Promise<GitResult> {
	return await new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd, stdio: inherit ? "inherit" : "pipe" });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];

		child.on("error", reject);
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("close", (code) => {
			const result = { code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
			if (result.code === 0 || allowFailure) resolve(result);
			else reject(new GitError(`git ${args[0]} failed`, code, result.stderr.toString("utf8")));
		});

		if (!inherit) {
			if (input) child.stdin?.end(input);
			else child.stdin?.end();
		}
	});
}

interface NameStatusRecord {
	status: string;
	/** The `b/` side of the diff: the destination for renames and copies. */
	path: string;
}

interface StagedNames {
	paths: string[];
	renames: RenamePair[];
	records: NameStatusRecord[];
}

function parseNames(output: Buffer): StagedNames {
	const fields = output.toString("utf8").split("\0");
	const paths: string[] = [];
	const renames: RenamePair[] = [];
	const records: NameStatusRecord[] = [];

	for (let index = 0; index < fields.length - 1;) {
		const status = fields[index++]!;
		const first = fields[index++]!;
		if (status.startsWith("R") || status.startsWith("C")) {
			const second = fields[index++]!;
			paths.push(first, second);
			renames.push({ from: first, to: second });
			records.push({ status, path: second });
		} else {
			paths.push(first);
			records.push({ status, path: first });
		}
	}

	return { paths, renames, records };
}

const DIFF_HEADER = Buffer.from("diff --git ");
const BINARY_MARKER = Buffer.from("Binary files ");
const NEWLINE = 0x0a;
const PLUS = 0x2b;
const MINUS = 0x2d;
const AT = 0x40;

/** Starting retention per file, halved whenever the total retained exceeds the budget. */
const INITIAL_PER_FILE_CAP = 8_192;
/** Never shrink below this: a head of a few lines is still worth more than nothing. */
const MIN_PER_FILE_CAP = 256;
const DEFAULT_RETAIN_BUDGET = 262_144;

interface Section {
	/** Everything after `diff --git `, used to recover the `b/` path. */
	header: string;
	added: number;
	deleted: number;
	bytes: number;
	chunks: Buffer[];
	retained: number;
	truncated: boolean;
	binary: boolean;
	inHunk: boolean;
}

function hasPrefix(line: Buffer, prefix: Buffer): boolean {
	return line.length >= prefix.length && line.subarray(0, prefix.length).equals(prefix);
}

/** Back `cut` up to the start of a UTF-8 sequence so truncation never splits a character. */
function utf8Boundary(buffer: Buffer, cut: number): number {
	let index = Math.min(cut, buffer.length);
	while (index > 0 && ((buffer[index] ?? 0) & 0xc0) === 0x80) index--;
	return index;
}

/**
 * Incremental `git diff` parser. Counts `+`/`-` lines and bytes over the whole of every section
 * while retaining only a bounded head of each, so peak memory is independent of the diff size.
 */
function createDiffParser(retainBudgetBytes: number) {
	const sections: Section[] = [];
	let perFileCap = INITIAL_PER_FILE_CAP;
	let totalRetained = 0;

	function retain(section: Section, line: Buffer): void {
		section.bytes += line.length;
		const room = perFileCap - section.retained;
		if (room <= 0) {
			section.truncated = true;
			return;
		}
		if (line.length <= room) {
			section.chunks.push(line);
			section.retained += line.length;
			totalRetained += line.length;
			return;
		}
		const cut = utf8Boundary(line, room);
		if (cut > 0) {
			section.chunks.push(line.subarray(0, cut));
			section.retained += cut;
			totalRetained += cut;
		}
		section.truncated = true;
	}

	/** Halve the per-file cap and re-truncate everything already held until we are back in budget. */
	function shrink(): void {
		while (totalRetained > retainBudgetBytes && perFileCap > MIN_PER_FILE_CAP) {
			perFileCap = Math.max(MIN_PER_FILE_CAP, perFileCap >> 1);
			for (const section of sections) {
				if (section.retained <= perFileCap) continue;
				const flat = Buffer.concat(section.chunks);
				const cut = utf8Boundary(flat, perFileCap);
				totalRetained -= section.retained - cut;
				section.chunks = cut > 0 ? [flat.subarray(0, cut)] : [];
				section.retained = cut;
				section.truncated = true;
			}
		}
	}

	function onLine(line: Buffer): void {
		if (hasPrefix(line, DIFF_HEADER)) {
			sections.push({
				header: line
					.toString("utf8")
					.slice(DIFF_HEADER.length)
					.replace(/\r?\n$/, ""),
				added: 0,
				deleted: 0,
				bytes: 0,
				chunks: [],
				retained: 0,
				truncated: false,
				binary: false,
				inHunk: false,
			});
		}
		const section = sections.at(-1);
		if (!section) return;

		retain(section, line);
		shrink();

		if (line[0] === AT && line[1] === AT) {
			section.inHunk = true;
			return;
		}
		// Before the first hunk header, `+++ `/`--- ` are file headers rather than changed lines.
		if (!section.inHunk) {
			if (hasPrefix(line, BINARY_MARKER)) section.binary = true;
			return;
		}
		if (line[0] === PLUS) section.added++;
		else if (line[0] === MINUS) section.deleted++;
	}

	return { onLine, sections };
}

/** Resolve a section header to an authoritative path via its `b/` side. */
function matchPath(header: string, paths: Set<string>): string | undefined {
	let index = header.indexOf(" b/");
	let fallback: string | undefined;
	while (index !== -1) {
		const candidate = header.slice(index + 3);
		if (paths.has(candidate)) return candidate;
		fallback = candidate;
		index = header.indexOf(" b/", index + 1);
	}
	return fallback;
}

/** Hand every complete line in `buffer` to `onLine`, returning the trailing partial line. */
function consumeLines(buffer: Buffer, onLine: (line: Buffer) => void): Buffer {
	let start = 0;
	for (;;) {
		const end = buffer.indexOf(NEWLINE, start);
		if (end === -1) break;
		onLine(buffer.subarray(start, end + 1));
		start = end + 1;
	}
	return buffer.subarray(start);
}

/** Spawn a git command and hand its stdout to `onLine` one complete line at a time. */
async function streamLines(args: string[], cwd: string, onLine: (line: Buffer) => void): Promise<void> {
	const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
	const stderr: Buffer[] = [];
	child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

	const exit = new Promise<number>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? 1));
	});

	// Chunk boundaries land anywhere, including mid-line. Splitting on `\n` bytes keeps every line
	// intact, and since `\n` cannot appear inside a multi-byte sequence, no character is ever split.
	let pending: Buffer = Buffer.alloc(0);
	for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
		pending = consumeLines(pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk, onLine);
	}
	if (pending.length > 0) onLine(pending);

	const code = await exit;
	if (code !== 0) throw new GitError(`git ${args[0]} failed`, code, Buffer.concat(stderr).toString("utf8"));
}

/**
 * Map parsed diff sections and name-status records to `StagedFile` records. Shared by
 * `parseRepository` and `readRepository` so the two paths cannot drift.
 */
function finishRepository(
	parser: ReturnType<typeof createDiffParser>,
	names: Buffer,
	history: string[]
): Omit<RepositoryChanges, "root"> {
	const { paths, renames, records } = parseNames(names);
	const known = new Set(records.map((record) => record.path));
	const byPath = new Map<string, Section>();
	for (const section of parser.sections) {
		const path = matchPath(section.header, known);
		if (path !== undefined && !byPath.has(path)) byPath.set(path, section);
	}

	const decoder = new TextDecoder("utf8");
	const files = records.map(({ path, status }): StagedFile => {
		const section = byPath.get(path);
		return {
			path,
			status,
			added: section?.added ?? 0,
			deleted: section?.deleted ?? 0,
			bytes: section?.bytes ?? 0,
			head: section ? decoder.decode(Buffer.concat(section.chunks)) : "",
			truncated: section?.truncated ?? false,
			binary: section?.binary ?? false,
		};
	});

	return { files, paths, renames, history };
}

/**
 * Turn raw `git diff --cached` and `--name-status -z` output into staged changes. Split out of
 * `readRepository` so fixtures and tests can drive it without a repository. Real repositories keep
 * going through `readRepository`, which streams the diff instead of buffering it.
 */
export function parseRepository(
	diff: Buffer,
	names: Buffer,
	history: string[],
	retainBudgetBytes = DEFAULT_RETAIN_BUDGET
): Omit<RepositoryChanges, "root"> {
	const parser = createDiffParser(retainBudgetBytes);
	const rest = consumeLines(diff, parser.onLine);
	if (rest.length > 0) parser.onLine(rest);
	return finishRepository(parser, names, history);
}

export async function readRepository(
	cwd = process.cwd(),
	stageAll = false,
	retainBudgetBytes = DEFAULT_RETAIN_BUDGET
): Promise<RepositoryChanges> {
	const root = (await git(["rev-parse", "--show-toplevel"], cwd)).stdout.toString("utf8").trim();
	if (stageAll) await git(["add", "-A"], root);

	const parser = createDiffParser(retainBudgetBytes);
	const [, names, log] = await Promise.all([
		// `core.quotePath=false` keeps header paths unescaped; the authoritative paths come from
		// `--name-status -z`, where quoting is disabled outright.
		streamLines(
			["-c", "core.quotePath=false", "diff", "--cached", "--find-renames", "--no-ext-diff"],
			root,
			parser.onLine
		),
		git(["diff", "--cached", "--name-status", "-z", "--find-renames"], root),
		git(["log", "-20", "--format=%s"], root, undefined, true),
	]);

	return {
		root,
		...finishRepository(
			parser,
			names.stdout,
			log.code === 0 ? log.stdout.toString("utf8").trimEnd().split("\n").filter(Boolean) : []
		),
	};
}

async function hasHead(root: string): Promise<boolean> {
	return (await git(["rev-parse", "--verify", "HEAD"], root, undefined, true)).code === 0;
}

async function resetIndex(root: string): Promise<void> {
	await git(["read-tree", ...((await hasHead(root)) ? ["HEAD"] : ["--empty"])], root);
}

async function applyPatch(root: string, patch: Buffer): Promise<void> {
	await git(["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], root, patch);
}

async function commit(root: string, group: CommitGroup): Promise<void> {
	const args = ["commit", "-m", group.subject];
	if (group.body?.trim()) args.push("-m", group.body);
	await git(args, root, undefined, false, true);
}

async function validateGroups(root: string, groups: CommitGroup[]): Promise<StagedNames> {
	const staged = parseNames((await git(["diff", "--cached", "--name-status", "-z", "--find-renames"], root)).stdout);
	const counts = new Map<string, number>();
	for (const { files } of groups) for (const file of files) counts.set(file, (counts.get(file) ?? 0) + 1);

	const invalid =
		staged.paths.some((path) => counts.get(path) !== 1) || [...counts].some(([path]) => !staged.paths.includes(path));
	if (invalid) throw new Error("Commit groups must contain every staged path exactly once");
	for (const { from, to } of staged.renames) {
		if (!groups.some(({ files }) => files.includes(from) && files.includes(to))) {
			throw new Error(`Rename paths must stay together: ${from} -> ${to}`);
		}
	}

	return staged;
}

/** Conservative argv allowance per `git diff`; ARG_MAX is 1 MiB with ~8 bytes of overhead per argument. */
const PATHSPEC_BUDGET = 262_144;
const ARGUMENT_OVERHEAD = 8;

/**
 * Split a group's pathspecs across invocations that stay well under ARG_MAX. Rename detection is
 * scoped to a single invocation, so both sides of a rename are kept in the same batch: split them
 * and git sees an unrelated delete and add, losing the pairing in the emitted patch.
 */
export function batchPathspecs(files: string[], renames: RenamePair[], budget = PATHSPEC_BUDGET): string[][] {
	const present = new Set(files);
	const partner = new Map<string, string>();
	for (const { from, to } of renames) {
		partner.set(from, to);
		partner.set(to, from);
	}

	const batches: string[][] = [];
	const placed = new Set<string>();
	let batch: string[] = [];
	let size = 0;

	for (const file of files) {
		if (placed.has(file)) continue;
		const other = partner.get(file);
		const unit = other !== undefined && other !== file && present.has(other) ? [file, other] : [file];
		let cost = 0;
		for (const path of unit) {
			placed.add(path);
			cost += Buffer.byteLength(path) + ARGUMENT_OVERHEAD;
		}
		if (batch.length > 0 && size + cost > budget) {
			batches.push(batch);
			batch = [];
			size = 0;
		}
		batch.push(...unit);
		size += cost;
	}
	if (batch.length > 0) batches.push(batch);

	return batches;
}

async function hasUpstream(root: string): Promise<boolean> {
	return (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root, undefined, true)).code === 0;
}

/** Push the current branch, setting the upstream when it has none yet. */
export async function pushCommits(root: string): Promise<void> {
	const args = (await hasUpstream(root)) ? ["push"] : ["push", "--set-upstream", "origin", "HEAD"];
	await git(args, root, undefined, false, true);
}

/** Commit the current index, splitting only at whole-file boundaries when requested. */
export async function createCommits(root: string, groups: CommitGroup[]): Promise<void> {
	if (groups.length === 0) throw new Error("The commit plan is empty");
	const staged = await validateGroups(root, groups);
	if (groups.length === 1) {
		await commit(root, groups[0]!);
		return;
	}

	const patches = await Promise.all(
		groups.map(async ({ files }) => {
			if (files.length === 0) throw new Error("A commit group has no files");
			const parts = await Promise.all(
				batchPathspecs(files, staged.renames).map(
					async (batch) =>
						(
							await git(
								[
									"--literal-pathspecs",
									"diff",
									"--cached",
									"--binary",
									"--full-index",
									"--find-renames",
									"--no-ext-diff",
									"--",
									...batch,
								],
								root
							)
						).stdout
				)
			);
			return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
		})
	);

	await resetIndex(root);
	for (let index = 0; index < groups.length; index++) {
		try {
			await applyPatch(root, patches[index]!);
			await commit(root, groups[index]!);
		} catch (error) {
			try {
				await resetIndex(root);
				for (const patch of patches.slice(index)) await applyPatch(root, patch);
			} catch (restoreError) {
				throw new Error("Commit failed and the index could not be restored", {
					cause: restoreError,
				});
			}
			throw error;
		}
	}
}
