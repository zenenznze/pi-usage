// Resolve the separately configured accounts plugin without a private Git dependency.
// Pure path logic: never opens settings, sessions, or credential stores.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function accountsModuleSpecifiers(agentDir: string, packages: unknown[]): string[] {
	const roots: string[] = [];
	for (const entry of packages) {
		if (
			typeof entry === "object" &&
			entry !== null &&
			"autoload" in entry &&
			entry.autoload === false
		)
			continue;
		const source =
			typeof entry === "string"
				? entry
				: typeof entry === "object" && entry !== null && "source" in entry
					? entry.source
					: undefined;
		if (typeof source !== "string") continue;
		const npm = /^npm:((?:@[^/]+\/)?[^@/]+)(?:@[^\s]+)?$/.exec(source);
		if (npm && (npm[1] === "pi-accounts" || npm[1]?.endsWith("/pi-accounts"))) {
			roots.push(join(agentDir, "npm", "node_modules", npm[1]));
		} else if (source.startsWith("git:")) {
			const repo = source.slice(4).replace(/\.git(?:@[^\s]+)?$/, "");
			try {
				const url = new URL(repo);
				if (url.pathname.endsWith("/pi-accounts") && ["ssh:", "https:"].includes(url.protocol)) {
					roots.push(join(agentDir, "git", url.hostname, url.pathname.replace(/^\//, "")));
				}
			} catch {
				/* Other Pi sources are not accounts plugin locations. */
			}
		}
	}
	return [...new Set(roots)].flatMap((root) => [
		pathToFileURL(join(root, "src", "account-store.ts")).href,
		pathToFileURL(join(root, "dist", "index.ts")).href,
	]);
}
