// Show every named OpenAI Codex account from pi-accounts with pi-usage's query logic.
// Usage: /accounts-usage in an interactive Pi session with @narumitw/pi-accounts and
// @narumitw/pi-usage installed. Account selection is persisted through AccountStore;
// pi-accounts applies it before the next Codex request.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const CODEX_PROVIDER = "openai-codex";
const QUERY_TIMEOUT_MS = 15_000;

type StoredOAuthCredential = {
	access: string;
	refresh: string;
	expires: number;
};

type ProviderAccountsData = {
	active?: string;
	accounts: Record<string, StoredOAuthCredential>;
};

type UsageBucket = {
	id: string;
	remaining?: number;
	resetsAt?: number;
};

type UsageReport = {
	metrics: Array<{ id: string; value: number | string }>;
	buckets: UsageBucket[];
};

type UsageAdapterModule = {
	adapterForProvider(providerId: string): unknown;
	queryProviderUsage(
		adapter: unknown,
		auth: {
			apiKey?: string;
			headers: Record<string, string>;
			fingerprint: string;
			secrets: string[];
			model: unknown;
		},
		signal: AbortSignal,
		timeoutMs: number,
	): Promise<UsageReport>;
};

type AccountsModule = {
	AccountStore: new () => AccountsUsageStore;
};

export type AccountsUsageStore = {
	readProviderAsync(providerId: string): Promise<ProviderAccountsData>;
	updateProvider(
		providerId: string,
		mutator: (state: ProviderAccountsData) => ProviderAccountsData,
	): Promise<ProviderAccountsData>;
};

export type AccountsUsageDependencies = {
	store?: AccountsUsageStore;
	queryUsage?: (
		credential: StoredOAuthCredential,
		accountName: string,
		ctx: ExtensionCommandContext,
		signal: AbortSignal,
	) => Promise<UsageReport>;
};

type AccountRow = {
	name: string;
	status: "loading" | "ready" | "error";
	report?: UsageReport;
	message?: string;
};

type PanelAction = { kind: "switch"; accountName: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

let usageModulePromise: Promise<UsageAdapterModule> | undefined;
let accountsModulePromise: Promise<AccountsModule> | undefined;

async function importFirst<T>(specifiers: string[]): Promise<T> {
	let lastError: unknown;
	for (const specifier of specifiers) {
		try {
			return (await import(specifier)) as T;
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function loadUsageModule(): Promise<UsageAdapterModule> {
	// This integration ships inside pi-usage. Resolve its own query module
	// relative to this file so Git/local installs do not require an npm copy.
	usageModulePromise ??= import("../query.js");
	return usageModulePromise;
}

function loadAccountsModule(): Promise<AccountsModule> {
	accountsModulePromise ??= importFirst<AccountsModule>([
		pathToFileURL(
			join(getAgentDir(), "npm/node_modules/@narumitw/pi-accounts/src/account-store.ts"),
		).href,
		pathToFileURL(join(getAgentDir(), "npm/node_modules/@narumitw/pi-accounts/dist/index.ts")).href,
		"@narumitw/pi-accounts/src/account-store.ts",
		"@narumitw/pi-accounts/dist/index.ts",
	]);
	return accountsModulePromise;
}

async function queryCodexUsage(
	credential: StoredOAuthCredential,
	accountName: string,
	ctx: ExtensionCommandContext,
	signal: AbortSignal,
): Promise<UsageReport> {
	const usage = await loadUsageModule();
	const adapter = usage.adapterForProvider(CODEX_PROVIDER);
	if (!adapter) {
		throw new Error("@narumitw/pi-usage does not expose the OpenAI Codex adapter.");
	}
	const auth = {
		apiKey: credential.access,
		headers: { Authorization: `Bearer ${credential.access}` },
		fingerprint: `accounts-usage:${accountName}:${credential.expires}`,
		secrets: [credential.access, credential.refresh],
		// pi-usage's Codex adapter currently only needs headers; retain the
		// model field required by its public ResolvedUsageAuth contract.
		model: ctx.model ?? { provider: CODEX_PROVIDER, id: "unknown" },
	};
	return usage.queryProviderUsage(adapter, auth, signal, QUERY_TIMEOUT_MS);
}

function pad(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function formatPercent(bucket: UsageBucket | undefined): string {
	if (!bucket || bucket.remaining === undefined) return "--";
	return `${Math.round(Math.max(0, Math.min(100, bucket.remaining)))}%`;
}

function findWindow(report: UsageReport, secondary: boolean): UsageBucket | undefined {
	return report.buckets.find((bucket) =>
		secondary ? bucket.id.endsWith(":secondary") : bucket.id.endsWith(":primary"),
	);
}

function formatReset(report: UsageReport): string {
	const primary = findWindow(report, false);
	const secondary = findWindow(report, true);
	const resetAt = primary?.resetsAt ?? secondary?.resetsAt;
	if (resetAt === undefined || !Number.isFinite(resetAt)) return "--";
	const remainingMs = Math.max(0, resetAt * 1000 - Date.now());
	const totalMinutes = Math.ceil(remainingMs / 60_000);
	if (totalMinutes <= 0) return "now";
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatCredits(report: UsageReport): string {
	const credits = report.metrics.find((metric) => metric.id === "credits");
	return credits ? `credits: ${credits.value}` : "no rate-limit data";
}

function formatError(error: string): string {
	const oneLine = error.replace(/[\r\n]+/g, " ").trim();
	return truncateToWidth(oneLine || "query failed", 80, "…");
}

class AccountsUsagePanel {
	private rows: AccountRow[] = [];
	private activeAccount: string | undefined;
	private selected = 0;
	private refreshing = false;
	private error: string | undefined;
	private request: AbortController | undefined;
	private disposed = false;
	private readonly tui: { requestRender(): void };
	private readonly theme: Theme;
	private readonly ctx: ExtensionCommandContext;
	private readonly store: AccountsUsageStore;
	private readonly queryUsage: AccountsUsageDependencies["queryUsage"];
	private readonly done: (action: PanelAction | undefined) => void;

	constructor(
		tui: { requestRender(): void },
		theme: Theme,
		ctx: ExtensionCommandContext,
		store: AccountsUsageStore,
		queryUsage: AccountsUsageDependencies["queryUsage"],
		done: (action: PanelAction | undefined) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.ctx = ctx;
		this.store = store;
		this.queryUsage = queryUsage;
		this.done = done;
	}

	start(): void {
		void this.refresh();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selected = Math.max(0, this.selected - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selected = Math.min(Math.max(0, this.rows.length - 1), this.selected + 1);
			this.tui.requestRender();
			return;
		}
		if (data.toLowerCase() === "r") {
			void this.refresh();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const row = this.rows[this.selected];
			if (row && !this.refreshing) this.done({ kind: "switch", accountName: row.name });
		}
	}

	async refresh(): Promise<void> {
		if (this.disposed) return;
		this.request?.abort();
		const request = new AbortController();
		this.request = request;
		this.refreshing = true;
		this.error = undefined;
		this.rows = [];
		this.selected = 0;
		this.tui.requestRender();

		try {
			const state = await this.store.readProviderAsync(CODEX_PROVIDER);
			if (this.isStale(request)) return;
			this.activeAccount = state.active;
			const names = Object.keys(state.accounts).sort((left, right) => left.localeCompare(right));
			this.rows = names.map((name) => ({ name, status: "loading" }));
			this.tui.requestRender();
			if (names.length === 0) return;

			const query = this.queryUsage ?? queryCodexUsage;
			const results = await Promise.all(
				names.map(async (name): Promise<AccountRow> => {
					const credential = state.accounts[name];
					if (!credential) return { name, status: "error", message: "credential missing" };
					try {
						const report = await query(credential, name, this.ctx, request.signal);
						return { name, status: "ready", report };
					} catch (error) {
						return { name, status: "error", message: formatError(errorMessage(error)) };
					}
				}),
			);
			if (this.isStale(request)) return;
			this.rows = results;
		} catch (error) {
			if (this.isStale(request) || request.signal.aborted) return;
			this.error = formatError(errorMessage(error));
		} finally {
			if (this.request === request) {
				this.refreshing = false;
				this.tui.requestRender();
			}
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const safeWidth = Math.max(1, width);
		const nameWidth = Math.max(12, Math.min(24, safeWidth - 43));
		const lines: string[] = [
			th.fg("borderMuted", "─".repeat(safeWidth)),
			truncateToWidth(th.fg("accent", th.bold("Codex accounts usage")), safeWidth),
			truncateToWidth(th.fg("muted", `Active: ${this.activeAccount ?? "default"}`), safeWidth),
			"",
		];

		if (this.error) lines.push(truncateToWidth(th.fg("error", this.error), safeWidth));
		if (this.rows.length === 0 && !this.error) {
			lines.push(
				truncateToWidth(
					th.fg(
						"dim",
						this.refreshing
							? "Loading accounts…"
							: "No named Codex accounts found. Use /accounts to log in.",
					),
					safeWidth,
				),
			);
		} else if (this.rows.length > 0) {
			const header = `   ${pad("Account", nameWidth)} ${pad("5h left", 8)} ${pad("Weekly", 8)} Reset`;
			lines.push(truncateToWidth(th.fg("dim", header), safeWidth));
			for (let index = 0; index < this.rows.length; index += 1) {
				const row = this.rows[index];
				if (!row) continue;
				const marker = index === this.selected ? th.fg("accent", "▶") : " ";
				const active = row.name === this.activeAccount ? th.fg("success", "●") : " ";
				let values: string;
				if (row.status === "loading") {
					values = th.fg("dim", "checking…");
				} else if (row.status === "error") {
					values = th.fg("error", row.message ?? "query failed");
				} else if (row.report) {
					const primary = findWindow(row.report, false);
					const secondary = findWindow(row.report, true);
					values = `${pad(formatPercent(primary), 8)} ${pad(formatPercent(secondary), 8)} ${formatReset(row.report)}`;
				} else {
					values = th.fg("error", "usage data missing");
				}
				const account = `${marker} ${active} ${pad(row.name, nameWidth)}`;
				lines.push(truncateToWidth(`${account} ${values}`, safeWidth));
				if (row.status === "ready" && row.report) {
					if (!findWindow(row.report, false) && !findWindow(row.report, true)) {
						lines.push(
							truncateToWidth(`      ${th.fg("muted", formatCredits(row.report))}`, safeWidth),
						);
					}
				}
			}
		}

		lines.push(
			"",
			truncateToWidth(th.fg("dim", "↑↓ select • Enter switch • R refresh • Esc close"), safeWidth),
		);
		lines.push(th.fg("borderMuted", "─".repeat(safeWidth)));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
		this.request?.abort();
		this.request = undefined;
	}

	private isStale(request: AbortController): boolean {
		return this.disposed || this.request !== request || request.signal.aborted;
	}
}

async function switchAccount(
	store: AccountsUsageStore,
	accountName: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	await ctx.waitForIdle();
	const latest = await store.readProviderAsync(CODEX_PROVIDER);
	if (!Object.hasOwn(latest.accounts, accountName)) {
		throw new Error(`Codex account "${accountName}" no longer exists.`);
	}
	if (latest.active === accountName) {
		ctx.ui.notify(`Codex account "${accountName}" is already active.`, "info");
		return;
	}
	await store.updateProvider(CODEX_PROVIDER, (state) => {
		if (!Object.hasOwn(state.accounts, accountName)) return state;
		return { ...state, active: accountName };
	});
	ctx.ui.notify(
		`Selected Codex account "${accountName}". pi-accounts will apply it before the next Codex request.`,
		"info",
	);
}

export default function accountsUsageExtension(
	pi: ExtensionAPI,
	dependencies: AccountsUsageDependencies = {},
): void {
	let defaultStore: AccountsUsageStore | undefined;
	const getStore = async (): Promise<AccountsUsageStore> => {
		if (defaultStore) return defaultStore;
		if (dependencies.store) {
			defaultStore = dependencies.store;
			return defaultStore;
		}
		const accounts = await loadAccountsModule();
		defaultStore = new accounts.AccountStore();
		return defaultStore;
	};

	pi.registerCommand("accounts-usage", {
		description: "Show and switch all named OpenAI Codex account usage",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("/accounts-usage does not accept arguments.", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/accounts-usage requires interactive TUI mode.", "error");
				return;
			}

			let store: AccountsUsageStore;
			try {
				store = await getStore();
			} catch (error) {
				ctx.ui.notify(`Could not load pi-accounts: ${errorMessage(error)}`, "error");
				return;
			}

			const action = await ctx.ui.custom<PanelAction | undefined>(
				(tui, theme, _keybindings, done) => {
					const panel = new AccountsUsagePanel(
						tui,
						theme,
						ctx,
						store,
						dependencies.queryUsage,
						done,
					);
					panel.start();
					return panel;
				},
			);

			if (action?.kind !== "switch") return;
			try {
				await switchAccount(store, action.accountName, ctx);
			} catch (error) {
				ctx.ui.notify(`Could not switch Codex account: ${errorMessage(error)}`, "error");
			}
		},
	});
}
