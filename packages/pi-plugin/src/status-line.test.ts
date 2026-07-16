import { describe, expect, it } from "bun:test";

import { registerStatusLine } from "./status-line";

interface MockContext {
	statuses: Array<[string, string | undefined]>;
	widgets: Array<[string, unknown, unknown]>;
	getContextUsage: () => { tokens: number; percent: number };
	sessionManager: { getSessionId: () => string };
	ui: {
		setStatus: (key: string, text: string | undefined) => void;
		setWidget: (key: string, content: unknown, options?: unknown) => void;
	};
}

type Handler = (event: unknown, ctx: MockContext) => Promise<void>;

function createPi() {
	const handlers = new Map<string, Handler>();
	return {
		pi: {
			on(event: string, handler: Handler) {
				handlers.set(event, handler);
			},
		},
		handlers,
	};
}

function createContext(): MockContext {
	const statuses: Array<[string, string | undefined]> = [];
	const widgets: Array<[string, unknown, unknown]> = [];
	return {
		statuses,
		widgets,
		getContextUsage: () => ({ tokens: 188_700, percent: 53 }),
		sessionManager: { getSessionId: () => "session-1" },
		ui: {
			setStatus(key: string, text: string | undefined) {
				statuses.push([key, text]);
			},
			setWidget(key: string, content: unknown, options?: unknown) {
				widgets.push([key, content, options]);
			},
		},
	};
}

const db = {
	prepare() {
		return { get: () => undefined };
	},
};

const theme = {
	bold: (text: string) => `<bold>${text}</bold>`,
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

describe("Magic Context status surface", () => {
	it("keeps OMP on one plain status surface and clears any retained widget", async () => {
		const { pi, handlers } = createPi();
		const ctx = createContext();
		registerStatusLine(pi as never, {
			db: db as never,
			projectIdentity: "/tmp/project",
			isOmpHost: true,
		});

		await handlers.get("session_start")?.({}, ctx);

		expect(ctx.widgets).toEqual([["magic-context", undefined, undefined]]);
		expect(ctx.statuses).toEqual([
			["magic-context", "mc: 188.7K (53%) · idle"],
		]);

		await handlers.get("session_shutdown")?.({}, ctx);
		expect(ctx.widgets.at(-1)).toEqual(["magic-context", undefined, undefined]);
		expect(ctx.statuses.at(-1)).toEqual(["magic-context", undefined]);
	});

	it("keeps native Pi on the plain setStatus surface", async () => {
		const { pi, handlers } = createPi();
		const ctx = createContext();
		registerStatusLine(pi as never, {
			db: db as never,
			projectIdentity: "/tmp/project",
			isOmpHost: false,
		});

		await handlers.get("session_start")?.({}, ctx);

		expect(ctx.widgets).toEqual([]);
		expect(ctx.statuses).toEqual([
			["magic-context", "mc: 188.7K (53%) · idle"],
		]);
	});
});
