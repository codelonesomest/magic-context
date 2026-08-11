import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { createPromptSurfaceRuntime } from "@magic-context/core/shared/prompt-surface-runtime";

import {
	clearOmpTaskChildRegistrar,
	createOmpTaskChildRegistrar,
	publishOmpTaskChildRegistrar,
	tryRegisterOmpTaskChildRuntime,
} from "./omp-task-child-runtime";
import { createTestDb } from "./test-utils.test";

function createRegistrationPi() {
	const tools: string[] = [];
	const events: string[] = [];
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		registerTool: mock((tool: { name?: string }) =>
			tools.push(tool.name ?? ""),
		),
		registerCommand: mock(() => undefined),
		on: mock((event: string, handler: (...args: unknown[]) => unknown) => {
			events.push(event);
			handlers.set(event, handler);
		}),
		getActiveTools: mock(() => tools),
	} as unknown as ExtensionAPI;
	return { pi, tools, events, handlers };
}

beforeEach(() => clearOmpTaskChildRegistrar());
afterEach(() => clearOmpTaskChildRegistrar());

describe("OMP Task child lightweight runtime", () => {
	it("fails closed outside OMP and without a primary-owned registrar", () => {
		const runtime = createRegistrationPi();
		expect(tryRegisterOmpTaskChildRuntime(runtime.pi, () => false)).toBe(false);
		expect(tryRegisterOmpTaskChildRuntime(runtime.pi, () => true)).toBe(false);
		expect(runtime.tools).toEqual([]);
		expect(runtime.events).toEqual([]);
	});

	it("registers only the bounded three-tool child surface", () => {
		const db = createTestDb();
		const config = MagicContextConfigSchema.parse({
			omp: { subagents: { compaction: false } },
		});
		const contextOptions = {
			db,
			compactionOff: false,
		} as never;
		const runtime = createRegistrationPi();
		const registrar = createOmpTaskChildRegistrar({
			db,
			registrationPromptSurface: config.prompt_surface,
			promptSurfaceRuntime: createPromptSurfaceRuntime({
				userConfigDirectory: process.cwd(),
				warn: () => undefined,
			}),
			resolveProject: () => ({
				config,
				contextOptions,
				projectIdentity: "test:project",
			}),
			resolveGuidance: () => ({ preset: "full" }),
			clearGuidance: () => undefined,
			persistMessageEndModelMeta: () => undefined,
			persistPressureFromMessageEnd: async () => undefined,
		});
		publishOmpTaskChildRegistrar(registrar);

		expect(tryRegisterOmpTaskChildRuntime(runtime.pi, () => true)).toBe(true);
		expect(runtime.tools).toEqual(["ctx_search", "ctx_expand", "ctx_reduce"]);
		expect(runtime.tools).not.toContain("ctx_note");
		expect(runtime.tools).not.toContain("ctx_memory");
		expect(runtime.tools).not.toContain("todowrite");
		expect(runtime.events).toContain("context");
		expect(runtime.events).toContain("before_agent_start");
		expect(runtime.events).toContain("message_end");
		expect(runtime.events).toContain("session_shutdown");
	});
});
