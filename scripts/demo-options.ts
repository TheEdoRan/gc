import type { BodyMode } from "../src/config.ts";

/** What `--offline` renders with, on every machine, whatever the maintainer's own config says. */
export const OFFLINE_DEFAULTS: { split: boolean; body: BodyMode } = { split: true, body: "manual" };

/**
 * Resolve the harness's split and body settings.
 *
 * CONTRIBUTING points contributors at `pnpm demo --offline` to see the review flow, so offline mode
 * may not inherit those two from whatever profile happens to be on the machine: `body: always` in a
 * user config would otherwise show a materially different screen from the defaults. The script's own
 * flags still win, which is why they carry no `parseArgs` default: only `undefined` can mean "not
 * passed". Online mode keeps reading the real config, since running the real profile is the point.
 */
export function resolveDemoOptions(
	flags: { offline: boolean; split?: boolean | undefined; body?: BodyMode | undefined },
	configured: { split: boolean; body: BodyMode }
): { split: boolean; body: BodyMode } {
	const defaults = flags.offline ? OFFLINE_DEFAULTS : configured;
	return { split: flags.split ?? defaults.split, body: flags.body ?? defaults.body };
}
