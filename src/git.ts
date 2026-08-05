import { spawn } from "node:child_process";

export interface RenamePair {
	from: string;
	to: string;
}

export interface RepositoryChanges {
	root: string;
	diff: string;
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

function parseNames(output: Buffer): Pick<RepositoryChanges, "paths" | "renames"> {
	const fields = output.toString("utf8").split("\0");
	const paths: string[] = [];
	const renames: RenamePair[] = [];

	for (let index = 0; index < fields.length - 1;) {
		const status = fields[index++]!;
		const first = fields[index++]!;
		if (status.startsWith("R") || status.startsWith("C")) {
			const second = fields[index++]!;
			paths.push(first, second);
			renames.push({ from: first, to: second });
		} else {
			paths.push(first);
		}
	}

	return { paths, renames };
}

export async function readRepository(cwd = process.cwd(), stageAll = false): Promise<RepositoryChanges> {
	const root = (await git(["rev-parse", "--show-toplevel"], cwd)).stdout.toString("utf8").trim();
	if (stageAll) await git(["add", "-A"], root);

	const [diff, names, log] = await Promise.all([
		git(["diff", "--cached", "--find-renames", "--no-ext-diff"], root),
		git(["diff", "--cached", "--name-status", "-z", "--find-renames"], root),
		git(["log", "-20", "--format=%s"], root, undefined, true),
	]);

	return {
		root,
		diff: diff.stdout.toString("utf8"),
		...parseNames(names.stdout),
		history: log.code === 0 ? log.stdout.toString("utf8").trimEnd().split("\n").filter(Boolean) : [],
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

async function validateGroups(root: string, groups: CommitGroup[]): Promise<void> {
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
}

/** Commit the current index, splitting only at whole-file boundaries when requested. */
export async function createCommits(root: string, groups: CommitGroup[]): Promise<void> {
	if (groups.length === 0) throw new Error("The commit plan is empty");
	await validateGroups(root, groups);
	if (groups.length === 1) {
		await commit(root, groups[0]!);
		return;
	}

	const patches = await Promise.all(
		groups.map(async ({ files }) => {
			if (files.length === 0) throw new Error("A commit group has no files");
			return (
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
						...files,
					],
					root
				)
			).stdout;
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
