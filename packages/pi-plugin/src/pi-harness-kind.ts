import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type PiHarnessKind = "pi" | "omp";

const OMP_UTILS_MODULE = "@oh-my-pi/pi-utils";
const HARNESS_KIND_SLOT = Symbol.for("magic-context.pi.harness-kind");

type HarnessKindGlobal = typeof globalThis & {
	[HARNESS_KIND_SLOT]?: PiHarnessKind;
};

function hostModuleRequesters(): string[] {
	return [
		...new Set(
			[process.argv[1], process.execPath]
				.filter(Boolean)
				.map((path) => resolve(path)),
		),
	];
}

function packageRootIsOmp(packageRoot: string): boolean {
	try {
		const manifest = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf-8"),
		) as { name?: unknown };
		return manifest.name === "@oh-my-pi/pi-coding-agent";
	} catch {
		return false;
	}
}

function detectPiHarnessKind(): PiHarnessKind {
	// Standalone OMP and package overrides may not expose pi-utils to Node.
	// PI_CODING_AGENT_DIR alone is not evidence: plain Pi supports it too.
	if (/^omp(?:\.exe)?$/.test(basename(process.execPath).toLowerCase())) {
		return "omp";
	}
	const packageOverride = process.env.PI_PACKAGE_DIR?.trim();
	if (packageOverride) {
		const packageRoot =
			packageOverride === "~"
				? homedir()
				: packageOverride.startsWith("~/") || packageOverride.startsWith("~\\")
					? resolve(homedir(), packageOverride.slice(2))
					: resolve(packageOverride);
		if (packageRootIsOmp(packageRoot)) return "omp";
	}
	let current = process.argv[1] ? dirname(resolve(process.argv[1])) : "";
	while (current) {
		if (packageRootIsOmp(current)) return "omp";
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	for (const requester of hostModuleRequesters()) {
		try {
			const requireFromHost = createRequire(requester);
			const modulePath = requireFromHost.resolve(OMP_UTILS_MODULE);
			const hostUtils = requireFromHost(modulePath) as { APP_NAME?: unknown };
			if (hostUtils.APP_NAME === "omp") return "omp";
		} catch {
			// Plain Pi does not install OMP utilities; keep trying host entry points.
		}
	}
	return "pi";
}

/** Resolve the Pi-compatible host from positive package, binary, or module evidence. */
export function resolvePiHarnessKind(): PiHarnessKind {
	const processGlobal = globalThis as HarnessKindGlobal;
	if (processGlobal[HARNESS_KIND_SLOT] === undefined) {
		processGlobal[HARNESS_KIND_SLOT] = detectPiHarnessKind();
	}
	return processGlobal[HARNESS_KIND_SLOT];
}

/** Test-only memo override. Passing undefined restores normal detection. */
export function __setPiHarnessKindForTesting(
	kind: PiHarnessKind | undefined,
): void {
	const processGlobal = globalThis as HarnessKindGlobal;
	if (kind === undefined) delete processGlobal[HARNESS_KIND_SLOT];
	else processGlobal[HARNESS_KIND_SLOT] = kind;
}
