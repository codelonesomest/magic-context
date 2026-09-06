import { describe, expect, it, mock } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import type { PendingPiCompactionMarker } from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	applyDeferredPiCompactionMarker,
	findLatestCompactionFirstKept,
} from "./compaction-marker-manager-pi";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { queueAndApplyPiRecompMarker } from "./pi-recomp-marker";
import { createTestDb } from "./test-utils.test";

function pending(
	overrides: Partial<PendingPiCompactionMarker> = {},
): PendingPiCompactionMarker {
	return {
		firstKeptEntryId: "entry-3",
		endMessageId: "m2",
		ordinal: 2,
		tokensBefore: 200,
		summary: "summary",
		publishedAt: 1,
		...overrides,
	};
}

function branch(extra: unknown[] = []): unknown[] {
	return [
		{ type: "message", id: "entry-1" },
		{ type: "message", id: "entry-2" },
		{ type: "message", id: "entry-3" },
		...extra,
	];
}

describe("Pi deferred compaction marker manager", () => {
	it("findLatestCompactionFirstKept walks newest-first", () => {
		expect(
			findLatestCompactionFirstKept([
				{ type: "compaction", firstKeptEntryId: "old" },
				{ type: "message", id: "entry" },
				{ type: "compaction", firstKeptEntryId: "new" },
			]),
		).toBe("new");
		expect(
			findLatestCompactionFirstKept([{ type: "message", id: "x" }]),
		).toBeNull();
	});

	it("keeps unsummarized messages when an OMP marker is persisted and projected", () => {
		const db = createTestDb();
		const sm = SessionManager.inMemory();
		const first = sm.appendMessage({
			role: "user",
			content: "covered",
			timestamp: 1,
		});
		const kept = sm.appendMessage({
			role: "user",
			content: "must survive",
			timestamp: 2,
		});
		const nativeOmp = {
			getBranch: () => sm.getBranch(),
			appendCompaction(
				summary: string,
				_shortSummary: string | undefined,
				firstKeptEntryId: string,
				tokensBefore: number,
				options: { details?: unknown; fromExtension?: boolean } = {},
			) {
				return sm.appendCompaction(
					summary,
					firstKeptEntryId,
					tokensBefore,
					options.details,
					options.fromExtension,
				);
			},
		};
		__setPiHarnessKindForTesting("omp");
		try {
			appendCompartments(db, "ses", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: first,
					endMessageId: first,
					title: "Covered",
					content: "Covered history",
				},
			]);
			queueAndApplyPiRecompMarker({
				db,
				sessionId: "ses",
				ctx: { sessionManager: nativeOmp },
			});
			expect(
				sm
					.buildSessionContext()
					.messages.filter((message) => message.role === "user"),
			).toEqual([{ role: "user", content: "must survive", timestamp: 2 }]);
			expect(sm.getBranch().at(-1)).toMatchObject({
				firstKeptEntryId: kept,
				tokensBefore: 0,
				fromHook: true,
				details: { source: "magic-context", lastCompactedOrdinal: 1 },
			});
		} finally {
			__setPiHarnessKindForTesting(undefined);
			closeQuietly(db);
		}
	});

	it("returns already-current without appending when latest compaction matches", () => {
		const db = createTestDb();
		try {
			appendCompartments(db, "ses", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "A",
					content: "B",
				},
			]);
			const appendCompaction = mock(() => "compact-1");
			expect(
				applyDeferredPiCompactionMarker(
					{
						db,
						readBranchEntries: () =>
							branch([{ type: "compaction", firstKeptEntryId: "entry-3" }]),
						appendCompaction,
					},
					"ses",
					pending(),
				).kind,
			).toBe("already-current");
			expect(appendCompaction).not.toHaveBeenCalled();
		} finally {
			closeQuietly(db);
		}
	});

	it("uses stale-reason precedence: compartment-removed before all later checks", () => {
		const db = createTestDb();
		try {
			const outcome = applyDeferredPiCompactionMarker(
				{
					db,
					readBranchEntries: () =>
						branch([{ type: "compaction", firstKeptEntryId: "entry-3" }]),
					appendCompaction: mock(() => "compact"),
				},
				"ses",
				pending({ firstKeptEntryId: "missing" }),
			);
			expect(outcome).toEqual({
				kind: "stale-skip",
				reason: "compartment-removed",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("uses stale-reason precedence: target-superseded before entry-removed/already-current", () => {
		const db = createTestDb();
		try {
			appendCompartments(db, "ses", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 99,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "A",
					content: "B",
				},
			]);
			const outcome = applyDeferredPiCompactionMarker(
				{
					db,
					readBranchEntries: () =>
						branch([{ type: "compaction", firstKeptEntryId: "entry-3" }]),
					appendCompaction: mock(() => "compact"),
				},
				"ses",
				pending({ firstKeptEntryId: "missing" }),
			);
			expect(outcome).toEqual({
				kind: "stale-skip",
				reason: "target-superseded",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("uses stale-reason precedence: entry-removed before already-current", () => {
		const db = createTestDb();
		try {
			appendCompartments(db, "ses", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "A",
					content: "B",
				},
			]);
			const outcome = applyDeferredPiCompactionMarker(
				{
					db,
					readBranchEntries: () =>
						branch([{ type: "compaction", firstKeptEntryId: "missing" }]),
					appendCompaction: mock(() => "compact"),
				},
				"ses",
				pending({ firstKeptEntryId: "missing" }),
			);
			expect(outcome).toEqual({ kind: "stale-skip", reason: "entry-removed" });
		} finally {
			closeQuietly(db);
		}
	});

	it("treats duplicate target compartments as compartment-removed and converts throws to retryable-failure", () => {
		const db = createTestDb();
		try {
			appendCompartments(db, "ses", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "A",
					content: "B",
				},
				{
					sequence: 1,
					startMessage: 3,
					endMessage: 2,
					startMessageId: "m3",
					endMessageId: "m2",
					title: "C",
					content: "D",
				},
			]);
			expect(
				applyDeferredPiCompactionMarker(
					{
						db,
						readBranchEntries: () => branch(),
						appendCompaction: mock(() => "compact"),
					},
					"ses",
					pending(),
				),
			).toEqual({ kind: "stale-skip", reason: "compartment-removed" });
			appendCompartments(db, "ses-throw", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "A",
					content: "B",
				},
			]);
			const retry = applyDeferredPiCompactionMarker(
				{
					db,
					readBranchEntries: () => branch(),
					appendCompaction: () => {
						throw new Error("busy");
					},
				},
				"ses-throw",
				pending(),
			);
			expect(retry.kind).toBe("retryable-failure");
		} finally {
			closeQuietly(db);
		}
	});
	it("treats a newer branch-order compaction as already current", () => {
		const db = createTestDb();
		try {
			appendCompartments(db, "ses", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "A",
					content: "B",
				},
			]);
			const appendCompaction = mock(() => "compact-1");
			const outcome = applyDeferredPiCompactionMarker(
				{
					db,
					readBranchEntries: () =>
						branch([
							{ type: "message", id: "entry-4" },
							{ type: "compaction", firstKeptEntryId: "entry-4" },
						]),
					appendCompaction,
				},
				"ses",
				pending(),
			);
			expect(outcome.kind).toBe("already-current");
			expect(appendCompaction).not.toHaveBeenCalled();
		} finally {
			closeQuietly(db);
		}
	});

	it("retries when appendCompaction returns no id", () => {
		const db = createTestDb();
		try {
			appendCompartments(db, "ses", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "A",
					content: "B",
				},
			]);
			const outcome = applyDeferredPiCompactionMarker(
				{
					db,
					readBranchEntries: () => branch(),
					appendCompaction: mock(() => undefined),
				},
				"ses",
				pending(),
			);
			expect(outcome.kind).toBe("retryable-failure");
		} finally {
			closeQuietly(db);
		}
	});
});
