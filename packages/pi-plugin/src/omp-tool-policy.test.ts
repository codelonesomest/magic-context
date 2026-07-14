import { describe, expect, it } from "bun:test";
import { resolveOmpToolPolicy } from "./omp-tool-policy";

describe("resolveOmpToolPolicy", () => {
	it("omits memory and note tools only for an OMP host", () => {
		expect(
			resolveOmpToolPolicy({
				isOmpHost: true,
				memoryEnabled: false,
				ctxNoteEnabled: false,
			}),
		).toEqual({ memoryToolEnabled: false, noteToolEnabled: false });

		expect(
			resolveOmpToolPolicy({
				isOmpHost: false,
				memoryEnabled: false,
				ctxNoteEnabled: false,
			}),
		).toEqual({ memoryToolEnabled: true, noteToolEnabled: true });
	});

	it("keeps both tools when their OMP features are enabled", () => {
		expect(
			resolveOmpToolPolicy({
				isOmpHost: true,
				memoryEnabled: true,
				ctxNoteEnabled: true,
			}),
		).toEqual({ memoryToolEnabled: true, noteToolEnabled: true });
	});
});
