import { resolveCortexKitUserConfigPath } from "@magic-context/core/config/migrate-config-location";
import {
    hasUserConfigLocationMigrationRefusal,
    migrateConfigLocationsForCli,
} from "../lib/config-location-migration";
import { runDreamerSetup } from "../lib/dreamer-setup";
import { pickModel } from "../lib/model-picker";
import {
    detectOmpBinary,
    getAvailableOmpModels,
    getOmpVersion,
    linkOmpPlugin,
    resolveOmpPluginPath,
} from "../lib/omp-helpers";
import { promptIO, type PromptIO } from "../lib/prompts";
import { writeMagicContextConfig } from "./setup-pi";

type EmbeddingChoice =
    | { provider: "local"; model: string }
    | {
          provider: "openai-compatible";
          endpoint: string;
          model: string;
          api_key?: string;
      };

export interface SetupEnvironment {
    detectOmpBinary: typeof detectOmpBinary;
    getOmpVersion: typeof getOmpVersion;
    getAvailableModels: typeof getAvailableOmpModels;
    linkPlugin: typeof linkOmpPlugin;
    resolvePluginPath: typeof resolveOmpPluginPath;
    getMagicContextConfigPath: typeof resolveCortexKitUserConfigPath;
}

export interface RunSetupOptions {
    prompts?: PromptIO;
    env?: SetupEnvironment;
    dryRun?: boolean;
    pluginPath?: string;
}

const DEFAULT_ENV: SetupEnvironment = {
    detectOmpBinary,
    getOmpVersion,
    getAvailableModels: getAvailableOmpModels,
    linkPlugin: linkOmpPlugin,
    resolvePluginPath: resolveOmpPluginPath,
    getMagicContextConfigPath: resolveCortexKitUserConfigPath,
};

function compactObject<T extends Record<string, unknown>>(object: T): T {
    for (const key of Object.keys(object)) {
        if (object[key] === undefined) delete object[key];
    }
    return object;
}

async function chooseEmbedding(prompts: PromptIO): Promise<EmbeddingChoice> {
    const provider = await prompts.selectOne("Select embedding provider", [
        {
            label: "Local embeddings — no API key required",
            value: "local",
            recommended: true,
        },
        { label: "OpenAI-compatible endpoint", value: "openai-compatible" },
    ]);
    if (provider === "local") {
        return { provider: "local", model: "Xenova/all-MiniLM-L6-v2" };
    }

    const endpoint = await prompts.text("Embedding endpoint URL", {
        placeholder: "https://api.openai.com/v1",
        validate: (value) => (value.trim().length === 0 ? "Endpoint is required" : undefined),
    });
    const model = await prompts.text("Embedding model", {
        initialValue: "text-embedding-3-small",
        validate: (value) => (value.trim().length === 0 ? "Model is required" : undefined),
    });
    const apiKey = await prompts.text("Embedding API key (optional; leave blank to use env)", {
        placeholder: "optional",
    });
    return compactObject({
        provider: "openai-compatible" as const,
        endpoint: endpoint.trim(),
        model: model.trim(),
        api_key: apiKey.trim() || undefined,
    });
}

export async function runSetup(options: RunSetupOptions = {}): Promise<number> {
    const prompts = options.prompts ?? promptIO;
    const env = options.env ?? DEFAULT_ENV;
    const dryRun = options.dryRun === true;

    prompts.intro("Magic Context for OMP — Setup");
    if (dryRun) {
        prompts.log.warn("Dry run — no files will be written and no plugin will be linked.");
        prompts.log.message(
            "[dry-run] would migrate legacy Magic Context config before reading or writing the shared CortexKit config.",
        );
    } else {
        const migrationWarnings = migrateConfigLocationsForCli(process.cwd(), prompts.log);
        if (hasUserConfigLocationMigrationRefusal(migrationWarnings)) {
            prompts.outro(
                "Setup stopped — resolve the legacy Magic Context user config migration conflict, then rerun setup.",
            );
            return 1;
        }
    }

    const spinner = prompts.spinner();
    spinner.start("Checking OMP installation");
    const omp = env.detectOmpBinary();
    if (!omp) {
        spinner.stop("OMP not found");
        prompts.log.warn("Could not find `omp` on PATH or at ~/.local/bin/omp.");
        prompts.log.message("Install OMP first, then rerun setup with --harness omp.");
        prompts.outro("Setup skipped");
        return 0;
    }

    const version = env.getOmpVersion(omp.path);
    spinner.stop(version ? `${version} detected at ${omp.path}` : `OMP detected at ${omp.path}`);
    spinner.start("Fetching available OMP models");
    const allModels = env.getAvailableModels(omp.path);
    spinner.stop(`Found ${allModels.length} model choices`);

    const configPath = env.getMagicContextConfigPath();
    const configureOmp = await prompts.confirm("Link this Magic Context fork into OMP?", true);
    let resolvedPluginPath: string | null = null;
    if (configureOmp) {
        resolvedPluginPath = env.resolvePluginPath(options.pluginPath);
        if (!resolvedPluginPath) {
            prompts.log.warn(
                "A built local OMP plugin was not found. Run the Pi plugin build and pass its directory with --plugin-path.",
            );
            prompts.log.message(
                "Expected a package named @cortexkit/pi-magic-context containing dist/index.js.",
            );
            prompts.outro("Setup stopped before changing OMP or shared config.");
            return 1;
        }
        if (dryRun) {
            prompts.log.message(
                `[dry-run] would run omp plugin link ${resolvedPluginPath} --scope user`,
            );
        } else {
            try {
                env.linkPlugin(omp.path, resolvedPluginPath);
                prompts.log.success(`Linked ${resolvedPluginPath} into OMP`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                prompts.log.warn(`OMP plugin link failed: ${message}`);
                prompts.outro("Setup stopped before changing shared config.");
                return 1;
            }
        }
    } else {
        prompts.log.warn(
            "Skipped OMP plugin linking; run `omp plugin link <packages/pi-plugin> --scope user` manually.",
        );
    }

    const historianModel = await pickModel(prompts, allModels, "historian");
    let historianThinkingLevel: string | undefined;
    if (historianModel.startsWith("github-copilot/")) {
        prompts.log.warn(
            "GitHub Copilot reasoning models require an explicit thinking level to avoid an invalid `minimal` default.",
        );
        historianThinkingLevel = await prompts.selectOne(
            "Select thinking level for historian",
            [
                {
                    label: "medium — good quality, moderate cost (Recommended)",
                    value: "medium",
                    recommended: true,
                },
                { label: "low — faster, less thorough", value: "low" },
                { label: "high — best quality, slowest", value: "high" },
                { label: "off — no thinking, fastest", value: "off" },
            ],
        );
    }

    const dreamerEnabled = await prompts.confirm(
        "Enable dreamer for overnight memory maintenance?",
        true,
    );
    let dreamerModel: string | undefined;
    let dreamerTasks: Record<string, { schedule: string }> | undefined;
    if (dreamerEnabled) {
        const result = await runDreamerSetup(prompts, allModels);
        dreamerModel = result.model;
        dreamerTasks = result.tasks;
    }
    const sidekickEnabled = await prompts.confirm("Enable sidekick for /ctx-aug?", false);
    const sidekickModel = sidekickEnabled
        ? await pickModel(prompts, allModels, "sidekick")
        : undefined;
    const embedding = await chooseEmbedding(prompts);

    if (dryRun) {
        prompts.log.message(`[dry-run] would write Magic Context config to ${configPath}`);
    } else {
        writeMagicContextConfig(configPath, {
            historianModel,
            historianThinkingLevel,
            dreamerEnabled,
            dreamerModel,
            dreamerTasks,
            sidekickEnabled,
            sidekickModel,
            embedding,
        });
        prompts.log.success(`Config written to ${configPath}`);
    }

    const thinkingLevelSuffix = historianThinkingLevel
        ? ` (thinking: ${historianThinkingLevel})`
        : "";
    const summary = [
        `OMP plugin: ${configureOmp ? resolvedPluginPath : "skipped"}`,
        `Magic Context config: ${configPath}`,
        `Historian: ${historianModel}${thinkingLevelSuffix}`,
        `Dreamer: ${dreamerEnabled ? dreamerModel : "disabled"}`,
        sidekickEnabled ? `Sidekick: ${sidekickModel}` : "Sidekick: disabled",
        `Embedding: ${embedding.provider}${"model" in embedding ? ` (${embedding.model})` : ""}`,
    ].join("\n");
    prompts.note(summary, dryRun ? "Configuration (dry run — not written)" : "Configuration");
    prompts.outro(
        dryRun ? "Dry run complete — nothing was written." : "Start an OMP session and try /ctx-status",
    );
    return 0;
}
