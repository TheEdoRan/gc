import path from "node:path";

import type { CommitPlan } from "./ai.ts";
import type { StagedFile } from "./git.ts";

export type Tier = "full" | "reduced" | "stats";

/** Mean changed-line length above which a file is treated as generated or minified. */
const MEAN_LINE_LENGTH_LIMIT = 200;
const DEFAULT_EXCERPT_LINES = 20;
const DEFAULT_MAX_GROUPS = 20;
const DETAIL_HEADING = "\n\nFiles shown individually:\n";

export const DEFAULT_EXCLUDE_GLOBS: string[] = [
	"**/pnpm-lock.yaml",
	"**/package-lock.json",
	"**/yarn.lock",
	"**/bun.lock*",
	"**/Cargo.lock",
	"**/composer.lock",
	"**/Gemfile.lock",
	"**/poetry.lock",
	"**/uv.lock",
	"**/go.sum",
	"**/Pipfile.lock",
	"**/flake.lock",
	"**/pubspec.lock",
	"**/gradle.lockfile",
	".claude/**",
	".agents/**",
	"**/*.min.*",
	"**/*.map",
	"dist/**",
	"build/**",
	"out/**",
	"vendor/**",
	"**/__snapshots__/**",
	"**/*.snap",
	"**/*.pb.go",
	"**/*_pb2.py",
	"**/*.generated.*",
];

export interface EvidenceOptions {
	byteBudget: number;
	exclude?: string[];
	include?: string[];
	excerptLines?: number;
	/** Groups to aggregate into when one line per file will not fit. Derived from the paths if absent. */
	groups?: Group[];
}

export interface Group {
	id: string;
	prefix: string;
	paths: string[];
}

export interface Evidence {
	block: string;
	summary: string;
	tiers: Map<string, Tier>;
}

function matchesAny(target: string, globs: string[]): boolean {
	return globs.some((glob) => path.matchesGlob(target, glob));
}

function formatBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit++;
	}
	return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function statsLine(file: StagedFile, reason: string): string {
	return `${file.path}  +${file.added} -${file.deleted}  (${reason})`;
}

/** Diff body lines that carry content, ignoring the `+++`/`---` file headers. */
function changedLines(head: string): string[] {
	return head
		.split("\n")
		.filter(
			(line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")
		);
}

function renderReduced(file: StagedFile, excerptLines: number): string {
	const lines = changedLines(file.head);
	const shown = lines.slice(0, excerptLines);
	// The excerpt is a prefix of the section, not a representative sample: for a lockfile the
	// alphabetically earliest records land first and can misrepresent the actual upgrade.
	const omitted = Math.max(file.added + file.deleted - shown.length, 0);
	return [
		statsLine(file, "content reduced"),
		...shown,
		...(omitted ? [`  ... ${omitted} more changed lines omitted`] : []),
	].join("\n");
}

/** The most detailed tier a file may reach, before the byte budget is considered. */
function capFor(file: StagedFile, exclude: string[], include: string[]): Tier {
	if (file.binary) return "stats";
	if (matchesAny(file.path, exclude) && !matchesAny(file.path, include)) return "reduced";
	const changed = file.added + file.deleted;
	if (changed > 0 && file.bytes / changed > MEAN_LINE_LENGTH_LIMIT) return "reduced";
	if (file.truncated) return "reduced";
	return "full";
}

interface Rendered {
	file: StagedFile;
	cap: Tier;
	tier: Tier;
	text: string;
	sizes: Record<Tier, number>;
}

export function buildEvidence(files: StagedFile[], options: EvidenceOptions): Evidence {
	const exclude = [...DEFAULT_EXCLUDE_GLOBS, ...(options.exclude ?? [])];
	const include = options.include ?? [];
	const excerptLines = options.excerptLines ?? DEFAULT_EXCERPT_LINES;

	const rendered = files.map((file): Rendered => {
		const cap = capFor(file, exclude, include);
		const stats = statsLine(file, file.binary ? "binary" : "content omitted");
		return {
			file,
			cap,
			tier: "stats",
			text: stats,
			sizes: {
				full: Buffer.byteLength(file.head.trimEnd()),
				reduced: Buffer.byteLength(renderReduced(file, excerptLines)),
				stats: Buffer.byteLength(stats),
			},
		};
	});

	// One stats line per file is normally the floor: every file stays in the block whatever the budget
	// says. At tens of thousands of files that floor alone dwarfs the budget, so fall back to one line
	// per directory group instead. Either way the floor is bounded and no file goes unreported.
	const statsFloor = rendered.reduce((total, entry) => total + entry.sizes.stats, 0) + Math.max(rendered.length - 1, 0);
	const aggregated = statsFloor > options.byteBudget;
	const groups = aggregated ? (options.groups ?? buildGroups(files.map((file) => file.path))) : [];
	const header = aggregated ? renderGroups(groups, new Map(files.map((file) => [file.path, file]))) : "";

	let remaining = aggregated
		? options.byteBudget - Buffer.byteLength(header) - Buffer.byteLength(DETAIL_HEADING)
		: options.byteBudget - statsFloor;

	for (const entry of [...rendered].sort((a, b) => a.file.bytes - b.file.bytes)) {
		const wanted: Tier[] = entry.cap === "full" ? ["full", "reduced"] : entry.cap === "reduced" ? ["reduced"] : [];
		for (const tier of wanted) {
			// When aggregating, an individual entry is additional detail rather than an upgrade of a
			// line already in the floor, so it costs its whole size plus its separating newline.
			const delta = aggregated ? entry.sizes[tier] + 1 : entry.sizes[tier] - entry.sizes.stats;
			if (delta > remaining) continue;
			remaining -= delta;
			entry.tier = tier;
			entry.text = tier === "full" ? entry.file.head.trimEnd() : renderReduced(entry.file, excerptLines);
			break;
		}
	}

	const counts = { full: 0, reduced: 0, stats: 0 };
	const tiers = new Map<string, Tier>();
	for (const entry of rendered) {
		counts[entry.tier]++;
		tiers.set(entry.file.path, entry.tier);
	}

	const detail = rendered.filter((entry) => !aggregated || entry.tier !== "stats");
	const block = aggregated
		? `${header}${detail.length ? `${DETAIL_HEADING}${detail.map((entry) => entry.text).join("\n")}` : ""}`
		: rendered.map((entry) => entry.text).join("\n");

	const parts: string[] = [];
	if (counts.full) parts.push(`${counts.full} ${counts.full === 1 ? "file" : "files"} in full`);
	if (counts.reduced) parts.push(`${counts.reduced} reduced to excerpts`);
	if (counts.stats) {
		parts.push(
			aggregated
				? `${counts.stats} aggregated into ${groups.length} ${groups.length === 1 ? "group" : "groups"}`
				: `${counts.stats} reduced to stats`
		);
	}
	const total = files.reduce((sum, file) => sum + file.bytes, 0);

	return {
		block,
		summary: `${parts.join(", ") || "no staged files"} (${formatBytes(total)})`,
		tiers,
	};
}

/** One line per group: enough to describe a bulk change without naming every file. */
function renderGroups(groups: Group[], byPath: Map<string, StagedFile>): string {
	return groups
		.map((group) => {
			let added = 0;
			let deleted = 0;
			let bytes = 0;
			for (const member of group.paths) {
				const file = byPath.get(member);
				if (!file) continue;
				added += file.added;
				deleted += file.deleted;
				bytes += file.bytes;
			}
			const count = `${group.paths.length} ${group.paths.length === 1 ? "file" : "files"}`;
			return `${group.id}  ${group.prefix}  ${count}  +${added} -${deleted}  (${formatBytes(bytes)}, content omitted)`;
		})
		.join("\n");
}

export function buildGroups(
	paths: string[],
	maxGroups = DEFAULT_MAX_GROUPS
): Array<{ id: string; prefix: string; paths: string[] }> {
	let prefixes = paths.map((file) => path.posix.dirname(file));
	// Rolling up strictly shortens every prefix until they all reach the repo root, so this ends.
	while (new Set(prefixes).size > maxGroups && prefixes.some((prefix) => prefix !== path.posix.dirname(prefix))) {
		prefixes = prefixes.map((prefix) => path.posix.dirname(prefix));
	}

	const groups = new Map<string, string[]>();
	for (const [index, prefix] of prefixes.entries()) {
		const bucket = groups.get(prefix);
		if (bucket) bucket.push(paths[index]!);
		else groups.set(prefix, [paths[index]!]);
	}

	return [...groups]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([prefix, members], index) => ({ id: `g${index + 1}`, prefix, paths: members }));
}

export function buildFallbackPlan(paths: string[]): CommitPlan {
	const directories = new Set(paths.map((file) => (file.includes("/") ? file.split("/")[0]! : "")));
	const scope = directories.size === 1 && !directories.has("") ? `(${[...directories][0]})` : "";
	return {
		commits: [
			{
				subject: `chore${scope}: update ${paths.length} ${paths.length === 1 ? "file" : "files"}`,
				body: "",
				files: [...paths],
			},
		],
	};
}
