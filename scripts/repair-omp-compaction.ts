#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";

/** Repair only the identifiable Pi-argument-shift records written to OMP sessions. */
export function repairOmpCompactionSession(inputPath: string, apply = false) {
	const path = realpathSync(inputPath);
	const assertClosed = () => {
		if (process.platform === "win32") {
			throw new Error("Apply requires a supported open-file probe; use a POSIX host with lsof.");
		}
		try {
			const holders = execFileSync("lsof", ["-F", "p", "--", path], {
				encoding: "utf8",
				timeout: 10_000,
				stdio: ["ignore", "pipe", "pipe"],
			});
			throw new Error(`Session is open; close its OMP process before repair (${holders.trim()}).`);
		} catch (error) {
			const failure = error as { status?: number; stdout?: string; stderr?: string };
			// lsof exits 1 with no output only when no matching descriptors exist.
			if (failure.status === 1 && !failure.stdout?.trim() && !failure.stderr?.trim()) return;
			throw error;
		}
	};
	if (apply) assertClosed();
	const originalStat = statSync(path, { bigint: true });
	if (!originalStat.isFile()) throw new Error("Session path must be a regular file.");
	const original = readFileSync(path, "utf8");
	// Keep every non-marker line and its exact newline bytes unchanged.
	const lines = original.split(/(?<=\n)/);
	const rows = lines.map((line) => line.trim() ? JSON.parse(line) : null);
	if (!rows.some((row) => row?.type === "session" && typeof row.id === "string")) {
		throw new Error("No session header found.");
	}
	const byId = new Map<string, { row: Record<string, unknown>; index: number }>();
	for (const [index, row] of rows.entries()) {
		if (row && typeof row.id === "string") {
			if (byId.has(row.id)) throw new Error(`Duplicate session entry ID: ${row.id}`);
			byId.set(row.id, { row, index });
		}
	}
	const repairs: { id: string; firstKeptEntryId: string; lastCompactedOrdinal: number }[] = [];
	for (const [index, row] of rows.entries()) {
		if (row?.type !== "compaction" || row.tokensBefore?.source !== "magic-context") continue;
		const details = row.tokensBefore;
		const kept = byId.get(row.shortSummary);
		if (
			typeof row.id !== "string" || typeof row.summary !== "string" ||
			!Number.isSafeInteger(row.firstKeptEntryId) || row.firstKeptEntryId < 0 ||
			!Number.isSafeInteger(details.lastCompactedOrdinal) || details.lastCompactedOrdinal < 0 ||
			typeof row.shortSummary !== "string" || !kept || kept.index >= index ||
			row.details !== undefined || row.fromExtension !== undefined ||
			kept.row.type !== "message"
		) {
			throw new Error(`Ambiguous MC marker ${row.id}; refusing to guess its boundary.`);
		}
		const seen = new Set<string>();
		let ancestor = row.parentId;
		while (typeof ancestor === "string" && ancestor !== row.shortSummary && !seen.has(ancestor)) {
			seen.add(ancestor);
			ancestor = byId.get(ancestor)?.row.parentId;
		}
		if (ancestor !== row.shortSummary) {
			throw new Error(`Kept entry is not on marker ${row.id}'s branch; refusing repair.`);
		}
		const repaired = {
			...row,
			firstKeptEntryId: row.shortSummary,
			tokensBefore: row.firstKeptEntryId,
			details,
			fromExtension: true,
		};
		delete repaired.shortSummary;
		const newline = lines[index]?.endsWith("\r\n") ? "\r\n" : lines[index]?.endsWith("\n") ? "\n" : "";
		lines[index] = JSON.stringify(repaired) + newline;
		repairs.push({ id: row.id, firstKeptEntryId: row.shortSummary, lastCompactedOrdinal: details.lastCompactedOrdinal });
	}
	if (!apply || repairs.length === 0) return { path, applied: false, repairs };
	const suffix = `${Date.now()}-${randomUUID()}`;
	const backup = `${path}.mc-marker-backup-${suffix}`;
	const temporary = `${path}.mc-marker-repair-${suffix}`;
	const assertUnchanged = () => {
		const current = statSync(path, { bigint: true });
		if (current.ino !== originalStat.ino || current.size !== originalStat.size ||
			current.mtimeNs !== originalStat.mtimeNs || readFileSync(path, "utf8") !== original) {
			throw new Error("Session changed during repair; original left untouched.");
		}
	};
	assertClosed();
	assertUnchanged();
	for (const [destination, contents] of [[backup, original], [temporary, lines.join("")]] as const) {
		const fd = openSync(destination, "wx", 0o600);
		try {
			writeFileSync(fd, contents, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
	try {
		assertClosed();
		assertUnchanged();
		renameSync(temporary, path);
	} catch (error) {
		unlinkSync(temporary);
		throw error;
	}
	return { path, applied: true, backup, repairs };
}

if (import.meta.main) {
	try {
		const args = process.argv.slice(2);
		if (args.length < 1 || args.length > 2 || (args[1] !== undefined && args[1] !== "--apply")) {
			throw new Error("Usage: bun scripts/repair-omp-compaction.ts <session.jsonl> [--apply]\nDefault: dry-run. Close the session before --apply; a full backup is retained.");
		}
		console.log(JSON.stringify(repairOmpCompactionSession(args[0]!, args[1] === "--apply"), null, 2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
