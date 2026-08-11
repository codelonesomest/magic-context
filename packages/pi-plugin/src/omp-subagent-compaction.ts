import { closeSync, openSync, readSync } from "node:fs";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";

import { isOmpHostProcess } from "./subagent-runner";

export const OMP_SUBAGENT_LIFECYCLE_EVENT = "task:subagent:lifecycle";
export const OMP_CHILD_JSONL_PREFIX_BYTES = 64 * 1024;

type LifecycleHandler = (event: unknown, ctx?: unknown) => unknown;
type Unsubscribe = () => void;

export type OmpLifecycleEventSource = {
	events?: {
		on?: (event: string, handler: LifecycleHandler) => unknown;
	};
	eventBus?: {
		on?: (event: string, handler: LifecycleHandler) => unknown;
		subscribe?: (event: string, handler: LifecycleHandler) => unknown;
	};
};

type PrefixReader = (path: string, maxBytes: number) => string | null;

export interface OmpSubagentCompactionRegistration {
	registered: boolean;
	unsubscribe?: Unsubscribe;
}

export interface OmpSubagentCompactionOptions {
	db: ContextDatabase;
	/** Runtime lifecycle classifier gate. Independent of historian enablement. */
	enabled?: boolean;
	isHostProcess?: () => boolean;
	readPrefix?: PrefixReader;
	updateSessionMeta?: typeof updateSessionMeta;
}

export function registerOmpSubagentCompaction(
	pi: OmpLifecycleEventSource,
	options: OmpSubagentCompactionOptions,
): OmpSubagentCompactionRegistration {
	if (options.enabled === false) return { registered: false };
	if (!(options.isHostProcess ?? isOmpHostProcess)())
		return { registered: false };

	const eventBus = resolveLifecycleEventBus(pi);
	if (!eventBus) return { registered: false };

	const handler: LifecycleHandler = (event) => {
		classifyOmpSubagentStartedEvent(event, options);
	};
	try {
		const unsubscribe = eventBus.register(
			OMP_SUBAGENT_LIFECYCLE_EVENT,
			handler,
		);
		return unsubscribe
			? { registered: true, unsubscribe }
			: { registered: true };
	} catch {
		return { registered: false };
	}
}

export function classifyOmpSubagentStartedEvent(
	event: unknown,
	options: Pick<
		OmpSubagentCompactionOptions,
		"db" | "readPrefix" | "updateSessionMeta"
	>,
): boolean {
	try {
		const payload = normalizeLifecyclePayload(event);
		if (!payload || !isStartedPayload(payload)) return false;
		const jsonlPath = getChildJsonlPath(payload);
		if (!jsonlPath) return false;

		const prefix = (options.readPrefix ?? readFilePrefix)(
			jsonlPath,
			OMP_CHILD_JSONL_PREFIX_BYTES,
		);
		if (prefix === null) return false;
		const sessionId = parseSessionHeaderId(prefix);
		if (!sessionId) return false;

		(options.updateSessionMeta ?? updateSessionMeta)(options.db, sessionId, {
			isSubagent: true,
		});
		return true;
	} catch {
		// Malformed payloads, unreadable JSONL, or storage races must not break the
		// host runtime. The child transform remains fail-closed until a later valid
		// lifecycle start attests the session.
		return false;
	}
}

function resolveLifecycleEventBus(pi: OmpLifecycleEventSource): {
	register: (
		event: string,
		handler: LifecycleHandler,
	) => Unsubscribe | undefined;
} | null {
	if (typeof pi.events?.on === "function") {
		return {
			register: (event, handler) =>
				asUnsubscribe(pi.events?.on?.(event, handler)),
		};
	}
	if (typeof pi.eventBus?.subscribe === "function") {
		return {
			register: (event, handler) =>
				asUnsubscribe(pi.eventBus?.subscribe?.(event, handler)),
		};
	}
	if (typeof pi.eventBus?.on === "function") {
		return {
			register: (event, handler) =>
				asUnsubscribe(pi.eventBus?.on?.(event, handler)),
		};
	}
	return null;
}

function asUnsubscribe(value: unknown): Unsubscribe | undefined {
	if (typeof value === "function") return value as Unsubscribe;
	if (
		value &&
		typeof value === "object" &&
		"unsubscribe" in value &&
		typeof (value as { unsubscribe?: unknown }).unsubscribe === "function"
	) {
		return () => (value as { unsubscribe: Unsubscribe }).unsubscribe();
	}
	if (
		value &&
		typeof value === "object" &&
		"dispose" in value &&
		typeof (value as { dispose?: unknown }).dispose === "function"
	) {
		return () => (value as { dispose: Unsubscribe }).dispose();
	}
	return undefined;
}

function normalizeLifecyclePayload(
	event: unknown,
): Record<string, unknown> | null {
	if (!event || typeof event !== "object") return null;
	const record = event as Record<string, unknown>;
	for (const key of ["payload", "data", "properties"]) {
		const value = record[key];
		if (value && typeof value === "object") {
			return value as Record<string, unknown>;
		}
	}
	return record;
}

function isStartedPayload(payload: Record<string, unknown>): boolean {
	return [
		payload.lifecycle,
		payload.phase,
		payload.status,
		payload.state,
		payload.event,
		payload.action,
		payload.kind,
		typeof payload.type === "string" &&
		payload.type !== OMP_SUBAGENT_LIFECYCLE_EVENT
			? payload.type
			: undefined,
	].some((value) => value === "started" || value === "start");
}

function getChildJsonlPath(payload: Record<string, unknown>): string | null {
	for (const key of [
		"jsonlPath",
		"jsonl_path",
		"sessionJsonlPath",
		"session_jsonl_path",
		"sessionPath",
		"session_path",
		"sessionFile",
		"session_file",
		"childJsonlPath",
		"child_jsonl_path",
		"childSessionPath",
		"child_session_path",
		"path",
	]) {
		const value = payload[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	const child = payload.child;
	if (child && typeof child === "object") {
		return getChildJsonlPath(child as Record<string, unknown>);
	}
	const session = payload.session;
	if (session && typeof session === "object") {
		return getChildJsonlPath(session as Record<string, unknown>);
	}
	return null;
}
function parseSessionHeaderId(prefix: string): string | null {
	for (const line of prefix.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object") continue;
		const header = parsed as Record<string, unknown>;
		if (header.type !== "session") continue;
		const id = header.id;
		if (typeof id === "string" && id.trim().length > 0) return id.trim();
	}
	return null;
}

function readFilePrefix(path: string, maxBytes: number): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.allocUnsafe(maxBytes);
		const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Ignore close failures; the classifier is fail-open.
			}
		}
	}
}

export const __test = {
	parseSessionHeaderId,
	getChildJsonlPath,
	isStartedPayload,
};
