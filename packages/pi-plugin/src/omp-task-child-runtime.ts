import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isCompactionEnabled } from "@magic-context/core/config/agent-disable";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import { scheduleIncrementalIndex } from "@magic-context/core/features/magic-context/message-index-async";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import type { PromptSurfaceConfig } from "@magic-context/core/shared/prompt-surface";
import type { PromptSurfaceRuntime } from "@magic-context/core/shared/prompt-surface-runtime";

import {
	clearContextHandlerSession,
	clearSystemPromptRefresh,
	hasSystemPromptRefresh,
	type PiContextHandlerOptions,
	registerPiContextHandler,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
	signalPiSystemPromptRefresh,
} from "./context-handler";
import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import { readPiSessionMessages } from "./read-session-pi";
import { stripTagPrefixFromAssistantMessage } from "./strip-tag-prefix";
import { isOmpHostProcess } from "./subagent-runner";
import {
	buildMagicContextBlock,
	clearPiSystemPromptSession,
	processSystemPromptForCache,
} from "./system-prompt";
import { registerMagicContextTools } from "./tools";

const OMP_TASK_CHILD_REGISTRAR = Symbol.for(
	"magic-context.pi.omp-task-child-registrar",
);

type TaskChildRegistrar = (pi: ExtensionAPI) => void;

export interface OmpTaskChildProjectDeps {
	config: MagicContextConfig;
	contextOptions: PiContextHandlerOptions;
	projectIdentity: string;
}

export interface OmpTaskChildRuntimeDeps {
	db: ContextDatabase;
	registrationPromptSurface: PromptSurfaceConfig;
	promptSurfaceRuntime: PromptSurfaceRuntime;
	resolveProject: (directory: string) => OmpTaskChildProjectDeps;
	resolveGuidance: (
		sessionId: string,
		config: PromptSurfaceConfig,
		modelKey?: string,
	) => {
		preset: "full" | "light";
		primaryOverride?: string;
	};
	clearGuidance: (sessionId: string) => void;
	persistMessageEndModelMeta: (args: {
		db: ContextDatabase;
		sessionId: string;
		message: unknown;
		cacheTtlConfig: MagicContextConfig["cache_ttl"];
	}) => void;
	persistPressureFromMessageEnd: (args: {
		db: ContextDatabase;
		sessionId: string;
		message: unknown;
		piContextWindow: number;
		piModel?: { provider?: string; id?: string; maxTokens?: number };
		piTokens?: number;
		notifyIssue?: (message: string) => unknown | Promise<unknown>;
	}) => Promise<void>;
}

/** Publish the one process-wide registrar owned by the full primary runtime. */
export function publishOmpTaskChildRegistrar(
	registrar: TaskChildRegistrar,
): void {
	(globalThis as Record<symbol, unknown>)[OMP_TASK_CHILD_REGISTRAR] = registrar;
}

export function clearOmpTaskChildRegistrar(): void {
	try {
		delete (globalThis as Record<symbol, unknown>)[OMP_TASK_CHILD_REGISTRAR];
	} catch {
		(globalThis as Record<symbol, unknown>)[OMP_TASK_CHILD_REGISTRAR] =
			undefined;
	}
}

/**
 * Bind the lightweight profile when OMP re-runs this extension factory for a
 * Task child. Native Pi keeps the upstream duplicate-init no-op contract.
 */
export function tryRegisterOmpTaskChildRuntime(
	pi: ExtensionAPI,
	isHostProcess: () => boolean = isOmpHostProcess,
): boolean {
	if (!isHostProcess()) return false;
	const registrar = (globalThis as Record<symbol, unknown>)[
		OMP_TASK_CHILD_REGISTRAR
	];
	if (typeof registrar !== "function") return false;
	(registrar as TaskChildRegistrar)(pi);
	return true;
}

export function createOmpTaskChildRegistrar(
	deps: OmpTaskChildRuntimeDeps,
): TaskChildRegistrar {
	return (pi) => {
		const childOptionsByDirectory = new Map<string, PiContextHandlerOptions>();
		const resolveChildOptions = (
			directory: string,
		): PiContextHandlerOptions => {
			const cached = childOptionsByDirectory.get(directory);
			if (cached) return cached;
			const project = deps.resolveProject(directory);
			const base = project.contextOptions;
			const child: PiContextHandlerOptions = {
				...base,
				heuristics: base.heuristics
					? { ...base.heuristics, caveman: undefined }
					: undefined,
				injection: base.injection
					? {
							...base.injection,
							memoryEnabled: false,
							injectDocs: false,
							userProfileEnabled: false,
							temporalAwareness: false,
							muralEnabled: false,
						}
					: undefined,
				autoSearch: undefined,
				maybeAutoEmbedSession: undefined,
				subagentCompaction: project.config.omp.subagents.compaction === true,
				isSubagentCtxReduceCallable: () =>
					pi.getActiveTools().includes("ctx_reduce"),
				requiresSubagentAttestation: true,
				resolveForProject: resolveChildOptions,
			};
			childOptionsByDirectory.set(directory, child);
			return child;
		};

		const bootProject = deps.resolveProject(process.cwd());
		const compactionOff = !isCompactionEnabled(bootProject.config);
		registerMagicContextTools(pi, {
			db: deps.db,
			ensureProjectRegistered: ensureProjectRegisteredFromPiDirectory,
			memoryEnabled: bootProject.config.memory.enabled,
			embeddingEnabled: bootProject.config.embedding.provider !== "off",
			gitCommitsEnabled:
				bootProject.config.memory.git_commit_indexing.enabled === true,
			resolveProjectIdentity: (ctx) =>
				deps.resolveProject(ctx.cwd).projectIdentity,
			memoryToolEnabled: false,
			noteToolEnabled: false,
			todowriteEnabled: false,
			todowriteCommandEnabled: false,
			protectedTags: bootProject.config.protected_tags ?? 20,
			resolveProtectedTags: (ctx) =>
				deps.resolveProject(ctx.cwd).config.protected_tags ?? 20,
			compactionOff,
			promptSurface: deps.registrationPromptSurface,
			promptSurfaceRuntime: deps.promptSurfaceRuntime,
		});
		registerPiContextHandler(pi, resolveChildOptions(process.cwd()));

		pi.on("before_agent_start", (event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			if (
				!sessionId ||
				!getOrCreateSessionMeta(deps.db, sessionId).isSubagent
			) {
				return;
			}
			const project = deps.resolveProject(ctx.cwd);
			if (project.config.system_prompt_injection?.enabled === false) return;
			const existingSystemPrompt = event.systemPrompt;
			const skipSignatures =
				project.config.system_prompt_injection?.skip_signatures ?? [];
			if (
				skipSignatures.some(
					(signature) =>
						signature.length > 0 && existingSystemPrompt.includes(signature),
				)
			) {
				return;
			}
			const model = ctx.model;
			const modelKey =
				typeof model?.provider === "string" && typeof model?.id === "string"
					? `${model.provider}/${model.id}`
					: undefined;
			const guidance = deps.resolveGuidance(
				sessionId,
				project.config.prompt_surface,
				modelKey,
			);
			const block = buildMagicContextBlock({
				db: deps.db,
				cwd: ctx.cwd,
				sessionId,
				memoryEnabled: false,
				includeGuidance: true,
				protectedTags: project.config.protected_tags,
				ctxReduceCallable: pi.getActiveTools().includes("ctx_reduce"),
				dreamerEnabled: false,
				temporalAwarenessEnabled: false,
				cavemanTextCompressionEnabled: false,
				subagentMode: true,
				language: project.config.language,
				promptSurfacePreset: guidance.preset,
				primaryGuidanceOverride: guidance.primaryOverride,
				existingSystemPrompt,
			});
			if (!block) return;
			const isCacheBusting = hasSystemPromptRefresh(sessionId);
			const result = processSystemPromptForCache({
				db: deps.db,
				sessionId,
				systemPrompt: `${existingSystemPrompt}\n\n${block}`,
				isCacheBusting,
				promptSurfacePreset: guidance.preset,
			});
			if (result.hashChanged) {
				signalPiHistoryRefresh(sessionId);
				signalPiSystemPromptRefresh(sessionId);
				signalPiPendingMaterialization(sessionId);
			}
			if (isCacheBusting) clearSystemPromptRefresh(sessionId);
			return { systemPrompt: result.systemPrompt };
		});

		pi.on("message_end", async (event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			if (
				!sessionId ||
				!getOrCreateSessionMeta(deps.db, sessionId).isSubagent
			) {
				return;
			}
			const message = event.message as unknown as {
				id?: string;
				role?: string;
				content?: unknown;
			};
			if (message.role === "assistant") {
				stripTagPrefixFromAssistantMessage(
					message as { role: string; content: unknown },
				);
				if (typeof message.id === "string" && message.id.length > 0) {
					const messageId = message.id;
					scheduleIncrementalIndex(
						deps.db,
						sessionId,
						messageId,
						() =>
							readPiSessionMessages(ctx).find(
								(candidate) => candidate.id === messageId,
							) ?? null,
					);
				}
			}
			const project = deps.resolveProject(ctx.cwd);
			deps.persistMessageEndModelMeta({
				db: deps.db,
				sessionId,
				message: event.message,
				cacheTtlConfig: project.config.cache_ttl,
			});
			const usage = ctx.getContextUsage?.();
			const contextWindow =
				usage &&
				typeof usage.contextWindow === "number" &&
				usage.contextWindow > 0
					? usage.contextWindow
					: (ctx.model?.contextWindow ?? 0);
			await deps.persistPressureFromMessageEnd({
				db: deps.db,
				sessionId,
				message: event.message,
				piContextWindow: contextWindow,
				piModel: ctx.model,
				piTokens:
					usage && typeof usage.tokens === "number" ? usage.tokens : undefined,
			});
		});

		pi.on("session_shutdown", (_event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) return;
			clearPiSystemPromptSession(sessionId);
			deps.clearGuidance(sessionId);
			clearContextHandlerSession(sessionId);
		});
	};
}

export const __test = {
	registrarSymbol: OMP_TASK_CHILD_REGISTRAR,
};
