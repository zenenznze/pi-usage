import assert from "node:assert/strict";
import { test, vi } from "vitest";
import accountsUsageExtension from "../src/accounts-usage-integration/accounts-usage.js";
import { adapterForProvider, queryProviderUsage } from "../src/query.js";
import { createMockContext, createMockPi } from "./support.js";

vi.mock("../src/query.js", () => ({
	adapterForProvider: vi.fn(() => ({ id: "openai-codex" })),
	queryProviderUsage: vi.fn(async () => ({
		metrics: [],
		buckets: [
			{ id: "codex:primary", remaining: 75 },
			{ id: "codex:secondary", remaining: 90 },
		],
	})),
}));

test("accounts-usage loads its own query module without a separate npm installation", async () => {
	const mock = createMockPi();
	const state = {
		active: "example",
		accounts: { example: { access: "synthetic-access", refresh: "synthetic-refresh", expires: 0 } },
	};
	accountsUsageExtension(mock.pi, {
		store: {
			readProviderAsync: async () => state,
			updateProvider: async () => state,
		},
	});
	let rendered = "";
	const context = createMockContext({
		mode: "tui",
		custom: async (factory: unknown) => {
			const create = factory as (
				tui: { requestRender(): void },
				theme: unknown,
				keybindings: unknown,
				done: () => void,
			) => { refresh(): Promise<void>; render(width: number): string[]; dispose(): void };
			const panel = create(
				{ requestRender() {} },
				{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
				{},
				() => {},
			);
			try {
				await panel.refresh();
				rendered = panel.render(120).join("\n");
			} finally {
				panel.dispose();
			}
		},
	});
	await mock.commands.get("accounts-usage")?.handler("", context.ctx);
	assert.equal(context.notifications.length, 0);
	assert.match(rendered, /example.*75%.*90%/);
	assert.doesNotMatch(rendered, /Cannot find module/);
	assert.ok(
		vi.mocked(adapterForProvider).mock.calls.some(([provider]) => provider === "openai-codex"),
	);
	assert.ok(vi.mocked(queryProviderUsage).mock.calls.length > 0);
});
