import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findOnPath } from "./find-on-path";

export interface OmpBinaryInfo {
    path: string;
    source: "path" | "home";
}

export function detectOmpBinary(): OmpBinaryInfo | null {
    const fromPath = findOnPath("omp");
    if (fromPath) return { path: fromPath, source: "path" };

    const homeCandidate =
        process.platform === "win32"
            ? join(homedir(), ".local", "bin", "omp.exe")
            : join(homedir(), ".local", "bin", "omp");
    if (existsSync(homeCandidate)) return { path: homeCandidate, source: "home" };
    return null;
}

export function getOmpVersion(ompPath: string): string | null {
    try {
        const result = spawnSync(ompPath, ["--version"], {
            encoding: "utf-8",
            timeout: 10_000,
        });
        const output = result.stdout?.trim() || result.stderr?.trim();
        return output || null;
    } catch {
        return null;
    }
}

export function parseOmpModelsOutput(output: string): string[] {
    let payload: unknown;
    try {
        payload = JSON.parse(output);
    } catch {
        return [];
    }
    if (payload === null || typeof payload !== "object" || !("models" in payload)) return [];
    if (!Array.isArray(payload.models)) return [];

    const selectors = new Set<string>();
    for (const model of payload.models) {
        if (model === null || typeof model !== "object" || !("selector" in model)) continue;
        if (typeof model.selector !== "string" || !model.selector.includes("/")) continue;
        selectors.add(model.selector);
    }
    return [...selectors];
}

export function getAvailableOmpModels(ompPath: string): string[] {
    try {
        const output = execFileSync(ompPath, ["models", "--json"], {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 20_000,
        });
        return parseOmpModelsOutput(output);
    } catch {
        return [];
    }
}

export function linkOmpPlugin(ompPath: string, pluginPath: string): void {
    execFileSync(ompPath, ["plugin", "link", pluginPath, "--scope", "user"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
    });
}

function isBuiltOmpPlugin(path: string): boolean {
    const manifestPath = join(path, "package.json");
    if (!existsSync(manifestPath) || !existsSync(join(path, "dist", "index.js"))) return false;
    try {
        const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
        if (manifest === null || typeof manifest !== "object" || !("name" in manifest)) return false;
        return manifest.name === "@cortexkit/pi-magic-context";
    } catch {
        return false;
    }
}

export function resolveOmpPluginPath(requestedPath?: string): string | null {
    const configuredPath = requestedPath?.trim() || process.env.MAGIC_CONTEXT_OMP_PLUGIN_PATH?.trim();
    if (configuredPath) {
        const absolutePath = resolve(configuredPath);
        return isBuiltOmpPlugin(absolutePath) ? absolutePath : null;
    }

    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        resolve(process.cwd(), "packages", "pi-plugin"),
        resolve(process.cwd(), "..", "pi-plugin"),
        resolve(moduleDir, "..", "..", "..", "pi-plugin"),
        resolve(moduleDir, "..", "..", "pi-plugin"),
    ];
    return candidates.find((candidate) => isBuiltOmpPlugin(candidate)) ?? null;
}
