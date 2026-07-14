import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "comment-json";
import { parseOmpModelsOutput } from "../lib/omp-helpers";
import type { PromptIO, PromptSpinner, SelectOption } from "../lib/prompts";
import { parseOmpSetupOptions } from "./setup";
import { runSetup, type SetupEnvironment } from "./setup-omp";

const tempRoots: string[] = [];
const originalHome = process.env.HOME;
const originalPiDir = process.env.PI_CODING_AGENT_DIR;
const originalConfigHome = process.env.XDG_CONFIG_HOME;

function makeTempRoot(): string {
    const path = mkdtempSync(join(tmpdir(), "mc-omp-setup-"));
    tempRoots.push(path);
    process.env.HOME = path;
    process.env.PI_CODING_AGENT_DIR = join(path, ".pi", "agent");
    process.env.XDG_CONFIG_HOME = join(path, ".config");
    return path;
}

class MockPrompts implements PromptIO {
    readonly messages: string[] = [];
    private readonly confirms: boolean[];

    constructor(confirms: boolean[]) {
        this.confirms = [...confirms];
    }

    readonly log = {
        info: (message: string) => this.messages.push(`info:${message}`),
        success: (message: string) => this.messages.push(`success:${message}`),
        warn: (message: string) => this.messages.push(`warn:${message}`),
        message: (message: string) => this.messages.push(`message:${message}`),
    };

    intro(message: string): void {
        this.messages.push(`intro:${message}`);
    }

    outro(message: string): void {
        this.messages.push(`outro:${message}`);
    }

    note(message: string, title?: string): void {
        this.messages.push(`note:${title ?? ""}:${message}`);
    }

    spinner(): PromptSpinner {
        return {
            start: (message: string) => this.messages.push(`spinner-start:${message}`),
            stop: (message: string) => this.messages.push(`spinner-stop:${message}`),
        };
    }

    async confirm(): Promise<boolean> {
        const next = this.confirms.shift();
        if (next === undefined) throw new Error("No mock confirm response queued");
        return next;
    }

    async text(_message: string, options = {}): Promise<string> {
        return options.initialValue ?? "";
    }

    async selectOne(_message: string, options: SelectOption[]): Promise<string> {
        const recommended = options.find((option) => option.recommended);
        return (recommended ?? options[0]).value;
    }

    async selectAutocomplete(_message: string, options: SelectOption[]): Promise<string> {
        const recommended = options.find((option) => option.recommended);
        return (recommended ?? options[0]).value;
    }
}

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiDir;
    if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigHome;

    for (const path of tempRoots.splice(0)) {
        rmSync(path, { recursive: true, force: true });
    }
});

describe("OMP setup", () => {
    it("links the local fork and writes only the shared Magic Context config", async () => {
        const root = makeTempRoot();
        const configPath = join(root, ".config", "cortexkit", "magic-context.jsonc");
        const pluginPath = join(root, "magic-context", "packages", "pi-plugin");
        const links: Array<{ ompPath: string; pluginPath: string }> = [];
        const env: SetupEnvironment = {
            detectOmpBinary: () => ({ path: join(root, "bin", "omp"), source: "path" }),
            getOmpVersion: () => "16.5.0",
            getAvailableModels: () => ["pq/gpt-5.5"],
            linkPlugin: (ompPath, localPluginPath) => {
                links.push({ ompPath, pluginPath: localPluginPath });
            },
            resolvePluginPath: (requestedPath) => requestedPath ?? null,
            getMagicContextConfigPath: () => configPath,
        };
        const prompts = new MockPrompts([true, false, false]);

        const code = await runSetup({ prompts, env, pluginPath });

        expect(code).toBe(0);
        expect(links).toEqual([{ ompPath: join(root, "bin", "omp"), pluginPath }]);
        expect(existsSync(join(root, ".pi", "agent", "settings.json"))).toBe(false);
        const config = parseJsonc(readFileSync(configPath, "utf-8"));
        expect(config).toMatchObject({
            historian: { model: "pq/gpt-5.5" },
            dreamer: { disable: true },
            sidekick: { disable: true },
        });
        expect(prompts.messages.join("\n")).toContain("Magic Context for OMP — Setup");
    });

    it("previews the OMP link without executing it or writing config", async () => {
        const root = makeTempRoot();
        const configPath = join(root, ".config", "cortexkit", "magic-context.jsonc");
        const pluginPath = join(root, "magic-context", "packages", "pi-plugin");
        const prompts = new MockPrompts([true, false, false]);
        const env: SetupEnvironment = {
            detectOmpBinary: () => ({ path: join(root, "bin", "omp"), source: "path" }),
            getOmpVersion: () => "16.5.0",
            getAvailableModels: () => ["pq/gpt-5.5"],
            linkPlugin: () => {
                throw new Error("dry run must not link");
            },
            resolvePluginPath: (requestedPath) => requestedPath ?? null,
            getMagicContextConfigPath: () => configPath,
        };

        const code = await runSetup({ prompts, env, pluginPath, dryRun: true });

        expect(code).toBe(0);
        expect(existsSync(configPath)).toBe(false);
        expect(prompts.messages.join("\n")).toContain(
            `[dry-run] would run omp plugin link ${pluginPath} --scope user`,
        );
    });
});

describe("parseOmpModelsOutput", () => {
    it("returns stable OMP selectors and ignores malformed entries", () => {
        const output = JSON.stringify({
            models: [
                { provider: "pq", id: "gpt-5.5", selector: "pq/gpt-5.5" },
                { provider: "anthropic", id: "claude-sonnet", selector: "anthropic/claude-sonnet" },
                { provider: "broken", id: "missing-selector" },
            ],
        });

        expect(parseOmpModelsOutput(output)).toEqual([
            "pq/gpt-5.5",
            "anthropic/claude-sonnet",
        ]);
        expect(parseOmpModelsOutput("not json")).toEqual([]);
    });
});

describe("parseOmpSetupOptions", () => {
    it("selects only explicit OMP setup invocations", () => {
        expect(
            parseOmpSetupOptions([
                "--harness",
                "omp",
                "--plugin-path",
                "/tmp/magic-context/packages/pi-plugin",
                "--dry-run",
            ]),
        ).toEqual({
            dryRun: true,
            pluginPath: "/tmp/magic-context/packages/pi-plugin",
        });
        expect(parseOmpSetupOptions(["--harness", "pi"])).toBeNull();
        expect(
            parseOmpSetupOptions(["--harness", "omp", "--plugin-path", "--dry-run"]),
        ).toEqual({ dryRun: true, pluginPath: undefined });
    });
});
