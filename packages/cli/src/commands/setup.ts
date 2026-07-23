/**
 * Unified `setup` command.
 *
 * Resolves the harness target via `--harness` flag or auto-detection. OpenCode
 * and Pi continue through their existing adapters and setup wizards. OMP is an
 * explicit fork-only target with its own plugin-link and model-discovery flow,
 * so none of its installation behavior leaks into native Pi or OpenCode.
 */
import type { HarnessAdapter } from "../adapters/types";
import { resolveAdaptersForCommand } from "../lib/harness-select";
import { intro, log, note, outro } from "../lib/prompts";
import { runSetup as runOmpSetup } from "./setup-omp";
import { runSetup as runOpenCodeSetup } from "./setup-opencode";
import { runSetup as runPiSetup } from "./setup-pi";

export interface OmpSetupOptions {
    dryRun: boolean;
    pluginPath: string | undefined;
}

export function parseOmpSetupOptions(argv: string[]): OmpSetupOptions | null {
    const harnessIndex = argv.indexOf("--harness");
    if (harnessIndex === -1 || argv[harnessIndex + 1] !== "omp") return null;

    const pluginPathIndex = argv.indexOf("--plugin-path");
    const pluginPathValue = pluginPathIndex === -1 ? undefined : argv[pluginPathIndex + 1];
    return {
        dryRun: argv.includes("--dry-run"),
        pluginPath: pluginPathValue?.startsWith("--") ? undefined : pluginPathValue,
    };
}

export async function runSetup(argv: string[]): Promise<number> {
    const dryRun = argv.includes("--dry-run");
    intro(dryRun ? "Magic Context setup (dry run)" : "Magic Context setup");

    const ompSetupOptions = parseOmpSetupOptions(argv);
    if (ompSetupOptions) {
        log.step("Configuring OMP (@cortexkit/pi-magic-context OMP fork)…");
        const code = await runOmpSetup(ompSetupOptions);
        if (code !== 0) {
            outro("Setup finished with warnings — see above.");
            return code;
        }
        if (!dryRun) {
            note(
                [
                    "Restart your OMP session so the linked extension registers.",
                    "Verify with: omp plugin doctor, then /ctx-status",
                ].join("\n"),
                "Next steps",
            );
        }
        outro(dryRun ? "Dry run done — no changes were made." : "Done.");
        return 0;
    }

    let adapters: HarnessAdapter[];
    try {
        adapters = await resolveAdaptersForCommand(argv, {
            // Every harness wizard writes the same Magic Context config. Keep setup
            // single-target until shared choices are collected once and registration
            // is split into harness-specific phases.
            allowMulti: false,
            verb: "setup",
        });
    } catch (error) {
        log.error(error instanceof Error ? error.message : String(error));
        outro("Setup stopped — correct the command arguments and try again.");
        return 1;
    }

    if (adapters.length === 0) {
        outro("No harness selected. Nothing to do.");
        return 0;
    }

    let anyFailure = false;
    for (const adapter of adapters) {
        log.step(`Configuring ${adapter.displayName} (${adapter.pluginPackageName})…`);

        // Each harness owns its no-host flow. In particular, an explicit OpenCode
        // setup can continue for a Desktop or not-yet-installed host.
        const code = await dispatchSetup(adapter, dryRun);
        if (code !== 0) {
            anyFailure = true;
            continue;
        }
        if (!dryRun) printNextSteps(adapter);
    }

    if (anyFailure) {
        outro("Setup finished with warnings — see above.");
        return 1;
    }
    outro(dryRun ? "Dry run done — no changes were made." : "Done.");
    return 0;
}

async function dispatchSetup(adapter: HarnessAdapter, dryRun: boolean): Promise<number> {
    switch (adapter.kind) {
        case "opencode":
            return runOpenCodeSetup(dryRun);
        case "pi":
            return runPiSetup({ dryRun });
    }
}

function printNextSteps(adapter: HarnessAdapter): void {
    if (adapter.kind === "opencode") {
        note(
            [
                "Restart OpenCode (or reload your session) so the plugin loads.",
                "Verify with: npx @cortexkit/magic-context@latest doctor",
            ].join("\n"),
            "Next steps",
        );
        return;
    }
    if (adapter.kind === "pi") {
        note(
            [
                "Restart your Pi session so the extension registers.",
                "Verify with: npx @cortexkit/magic-context@latest doctor --harness pi",
            ].join("\n"),
            "Next steps",
        );
    }
}
