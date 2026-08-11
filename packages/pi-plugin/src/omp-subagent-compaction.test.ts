/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	closeDatabase,
	getOrCreateSessionMeta,
	runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";

import {
	classifyOmpSubagentStartedEvent,
	OMP_CHILD_JSONL_PREFIX_BYTES,
	OMP_SUBAGENT_LIFECYCLE_EVENT,
	registerOmpSubagentCompaction,
} from "./omp-subagent-compaction";

type Handler = (event: unknown, ctx?: unknown) => unknown;

const tempDirs: string[] = [];

afterEach(() => {
	closeDatabase();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

function makeMemoryDatabase(): Database {
	const db = new Database(":memory:");
	initializeDatabase(db);
	runMigrations(db);
	return db;
}

function makeTempJsonl(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "mc-omp-subagent-"));
	tempDirs.push(dir);
	const path = join(dir, "child.jsonl");
	writeFileSync(path, content);
	return path;
}

describe("OMP subagent compaction lifecycle classifier", () => {
	it("registers only for OMP when enabled and preserves unsubscriber ownership", () => {
		const unsubscribe = mock(() => undefined);
		const eventBusSubscribe = mock((event: string, handler: Handler) => ({
			event,
			handler,
			unsubscribe,
		}));
		const pi = { events: { on: eventBusSubscribe } };
		const db = makeMemoryDatabase();

		const native = registerOmpSubagentCompaction(pi, {
			db,
			enabled: true,
			isHostProcess: () => false,
		});
		const disabled = registerOmpSubagentCompaction(pi, {
			db,
			enabled: false,
			isHostProcess: () => true,
		});
		const omp = registerOmpSubagentCompaction(pi, {
			db,
			enabled: true,
			isHostProcess: () => true,
		});

		expect(native).toEqual({ registered: false });
		expect(disabled).toEqual({ registered: false });
		expect(omp.registered).toBe(true);
		expect(typeof omp.unsubscribe).toBe("function");
		omp.unsubscribe?.();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(eventBusSubscribe).toHaveBeenCalledTimes(1);
		expect(eventBusSubscribe).toHaveBeenCalledWith(
			OMP_SUBAGENT_LIFECYCLE_EVENT,
			expect.any(Function),
		);
		closeQuietly(db);
	});

	it("marks started child sessions from the host-owned JSONL session header", () => {
		const db = makeMemoryDatabase();
		const jsonlPath = makeTempJsonl(
			'{"type":"session","id":"ses_child_123"}\n{"type":"message","id":"m1"}\n',
		);

		const classified = classifyOmpSubagentStartedEvent(
			{
				id: "omp-task-run-id",
				agent: "scout",
				status: "started",
				sessionFile: jsonlPath,
				index: 0,
			},
			{ db },
		);

		expect(classified).toBe(true);
		expect(getOrCreateSessionMeta(db, "ses_child_123").isSubagent).toBe(true);
		closeQuietly(db);
	});

	it("ignores non-start, malformed, and missing child JSONL files", () => {
		const db = makeMemoryDatabase();
		const malformedPath = makeTempJsonl(
			'{"type":"message","id":"not-a-header"}\n',
		);
		const emptyIdPath = makeTempJsonl('{"type":"session","id":"   "}\n');
		const missingPath = join(tmpdir(), "mc-omp-subagent-missing.jsonl");

		const nonStart = classifyOmpSubagentStartedEvent(
			{ status: "finished", jsonlPath: malformedPath },
			{ db },
		);
		const malformed = classifyOmpSubagentStartedEvent(
			{ status: "started", jsonlPath: malformedPath },
			{ db },
		);
		const missing = classifyOmpSubagentStartedEvent(
			{ status: "started", jsonlPath: missingPath },
			{ db },
		);
		const emptyId = classifyOmpSubagentStartedEvent(
			{ status: "started", jsonlPath: emptyIdPath },
			{ db },
		);
		const badPayload = classifyOmpSubagentStartedEvent(null, { db });

		expect(nonStart).toBe(false);
		expect(malformed).toBe(false);
		expect(missing).toBe(false);
		expect(emptyId).toBe(false);
		expect(badPayload).toBe(false);
		expect(getOrCreateSessionMeta(db, "not-a-header").isSubagent).toBe(false);
		closeQuietly(db);
	});

	it("reads only a bounded prefix of the child JSONL", () => {
		const db = makeMemoryDatabase();
		const readPrefix = mock(() => '{"type":"session","id":"ses_bounded"}\n');

		const classified = classifyOmpSubagentStartedEvent(
			{ status: "started", sessionPath: "/host/owned/child.jsonl" },
			{ db, readPrefix },
		);

		expect(classified).toBe(true);
		expect(readPrefix).toHaveBeenCalledWith(
			"/host/owned/child.jsonl",
			OMP_CHILD_JSONL_PREFIX_BYTES,
		);
		expect(getOrCreateSessionMeta(db, "ses_bounded").isSubagent).toBe(true);
		closeQuietly(db);
	});
});
