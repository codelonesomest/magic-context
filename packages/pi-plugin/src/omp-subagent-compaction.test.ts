import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestDb } from "./test-utils.test";
import {
	OMP_TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	registerOmpTaskSubagentLifecycle,
} from "./omp-subagent-compaction";

describe("OMP task subagent lifecycle", () => {
	it("classifies a lifecycle-attested child from OMP's session header", () => {
		const db = createTestDb();
		const sessionDirectory = mkdtempSync(join(tmpdir(), "mc-omp-task-session-"));
		try {
			const sessionFile = join(sessionDirectory, "ChildAgent.jsonl");
			writeFileSync(
				sessionFile,
				`${JSON.stringify({ type: "session", id: "ses-omp-child" })}\n`,
			);
			let lifecycleHandler: ((payload: unknown) => void) | undefined;
			const pi = {
				events: {
					on: (channel: string, handler: (payload: unknown) => void) => {
						expect(channel).toBe(OMP_TASK_SUBAGENT_LIFECYCLE_CHANNEL);
						lifecycleHandler = handler;
						return () => undefined;
					},
				},
			};
			registerOmpTaskSubagentLifecycle(pi as never, { db, isOmpHost: true });

			expect(lifecycleHandler).toBeDefined();
			lifecycleHandler?.({
				id: "ChildAgent",
				agent: "task",
				agentSource: "builtin",
				status: "started",
				sessionFile,
				index: 0,
			});

			expect(getOrCreateSessionMeta(db, "ses-omp-child").isSubagent).toBe(true);
		} finally {
			closeQuietly(db);
			rmSync(sessionDirectory, { recursive: true, force: true });
		}
	});

	it("does not classify native Pi sessions", async () => {
		const db = createTestDb();
		try {
			const handlers = new Map<
				string,
				(event: unknown, ctx: unknown) => unknown
			>();
			let subscribed = false;
			const pi = {
				events: {
					on: () => {
						subscribed = true;
						return () => undefined;
					},
				},
				on: (
					event: string,
					handler: (event: unknown, ctx: unknown) => unknown,
				) => {
					handlers.set(event, handler);
				},
			};
			registerOmpTaskSubagentLifecycle(pi as never, { db, isOmpHost: false });

			expect(subscribed).toBe(false);
			expect(handlers.size).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});
});
