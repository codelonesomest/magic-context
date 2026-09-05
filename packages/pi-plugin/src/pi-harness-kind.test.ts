import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	__setPiHarnessKindForTesting,
	resolvePiHarnessKind,
} from "./pi-harness-kind";

const originalArgv1 = process.argv[1];
const originalPackageDir = process.env.PI_PACKAGE_DIR;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const temporaryRoots: string[] = [];

function fakeHost(appName?: string): string {
	const root = mkdtempSync(join(tmpdir(), "mc-pi-harness-kind-"));
	temporaryRoots.push(root);
	const hostEntry = join(root, "host.js");
	writeFileSync(hostEntry, "// fake host entry\n");
	if (appName !== undefined) {
		const moduleRoot = join(root, "node_modules", "@oh-my-pi", "pi-utils");
		mkdirSync(moduleRoot, { recursive: true });
		writeFileSync(
			join(moduleRoot, "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-utils", main: "index.cjs" }),
		);
		writeFileSync(
			join(moduleRoot, "index.cjs"),
			`exports.APP_NAME = ${JSON.stringify(appName)};\n`,
		);
	}
	return hostEntry;
}

beforeEach(() => {
	__setPiHarnessKindForTesting(undefined);
	delete process.env.PI_PACKAGE_DIR;
	delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
	__setPiHarnessKindForTesting(undefined);
	if (originalPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
	else process.env.PI_PACKAGE_DIR = originalPackageDir;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalArgv1 === undefined) process.argv.splice(1, 1);
	else process.argv[1] = originalArgv1;
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("resolvePiHarnessKind", () => {
	it("detects OMP from APP_NAME resolved through the running host module graph", () => {
		process.argv[1] = fakeHost("omp");

		expect(resolvePiHarnessKind()).toBe("omp");
	});

	it("falls back to Pi when @oh-my-pi/pi-utils is absent", () => {
		process.argv[1] = fakeHost();

		expect(resolvePiHarnessKind()).toBe("pi");
	});

	it("detects an OMP package override without host-resolvable utilities", () => {
		process.argv[1] = fakeHost();
		const packageRoot = join(process.argv[1], "..");
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({
				name: "@oh-my-pi/pi-coding-agent",
			}),
		);
		process.env.PI_PACKAGE_DIR = packageRoot;
		process.argv[1] = fakeHost();

		expect(resolvePiHarnessKind()).toBe("omp");
	});

	it("detects an OMP running package without host-resolvable utilities", () => {
		process.argv[1] = fakeHost();
		writeFileSync(
			join(process.argv[1], "..", "package.json"),
			JSON.stringify({
				name: "@oh-my-pi/pi-coding-agent",
			}),
		);

		expect(resolvePiHarnessKind()).toBe("omp");
	});

	it("does not identify plain Pi from an agent directory or Pi package override", () => {
		process.argv[1] = fakeHost();
		const packageRoot = join(process.argv[1], "..");
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
			}),
		);
		process.env.PI_PACKAGE_DIR = packageRoot;
		process.env.PI_CODING_AGENT_DIR = "/tmp/omp-agent";

		expect(resolvePiHarnessKind()).toBe("pi");
	});

	it("memoizes the detected harness for the process", () => {
		process.argv[1] = fakeHost("omp");
		expect(resolvePiHarnessKind()).toBe("omp");
		process.argv[1] = fakeHost();

		expect(resolvePiHarnessKind()).toBe("omp");
	});
});
