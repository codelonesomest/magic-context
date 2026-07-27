import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type ContextDatabase,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";

export const OMP_TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";

type EventBusLike = {
	on(channel: string, handler: (payload: unknown) => void): () => void;
};

type OmpExtensionApi = {
	events?: EventBusLike;
};

function normalizeSessionFile(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return resolve(value);
}

function readTaskSessionId(sessionFile: string): string | undefined {
	try {
		const header = readFileSync(sessionFile, "utf8").slice(0, 16 * 1024);
		for (const line of header.split("\n")) {
			const parsed = JSON.parse(line) as { type?: unknown; id?: unknown };
			if (parsed.type === "session" && typeof parsed.id === "string") {
				return parsed.id;
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function classifyTaskSessionFromLifecycle(
	db: ContextDatabase,
	payload: unknown,
): void {
	if (!payload || typeof payload !== "object") return;
	const event = payload as { status?: unknown; sessionFile?: unknown };
	if (event.status !== "started") return;
	const sessionFile = normalizeSessionFile(event.sessionFile);
	if (!sessionFile) return;
	const sessionId = readTaskSessionId(sessionFile);
	if (!sessionId) return;
	updateSessionMeta(db, sessionId, { isSubagent: true });
}

/**
 * OMP emits a parent-visible lifecycle event after it has persisted each task
 * child's transcript header. Reading that host-owned session ID lets the parent
 * mark the shared Magic Context record before the child's first model turn.
 */
export function registerOmpTaskSubagentLifecycle(
	pi: OmpExtensionApi,
	deps: { db: ContextDatabase; isOmpHost: boolean },
): boolean {
	if (!deps.isOmpHost || typeof pi.events?.on !== "function") return false;
	pi.events.on(OMP_TASK_SUBAGENT_LIFECYCLE_CHANNEL, (payload) => {
		classifyTaskSessionFromLifecycle(deps.db, payload);
	});
	return true;
}

export const __test = {
	readTaskSessionId,
};
