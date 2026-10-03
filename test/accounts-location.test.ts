import assert from "node:assert/strict";
import { test } from "vitest";
import { accountsModuleSpecifiers } from "../src/accounts-usage-integration/accounts-location.js";

test("resolves our npm scope, not a hardcoded upstream account package", () => {
	const result = accountsModuleSpecifiers("/fake-agent", ["npm:@our-scope/pi-accounts@1.0.0"]);
	assert.equal(
		result[0],
		"file:///fake-agent/npm/node_modules/@our-scope/pi-accounts/src/account-store.ts",
	);
	assert.ok(result.every((path) => !path.includes("narumitw")));
});
test("resolves the currently supported self-hosted Git installation", () => {
	assert.equal(
		accountsModuleSpecifiers("/fake-agent", ["git:ssh://gitea/joe/pi-accounts.git@abc"])[0],
		"file:///fake-agent/git/gitea/joe/pi-accounts/src/account-store.ts",
	);
});
test("ignores unrelated, malformed and disabled plugins and deduplicates", () => {
	const source = "npm:@our-scope/pi-accounts@1.0.0";
	assert.equal(
		accountsModuleSpecifiers("/fake-agent", [
			{ source, autoload: false },
			"npm:@our-scope/pi-usage",
			"git:broken",
		]).length,
		0,
	);
	assert.equal(accountsModuleSpecifiers("/fake-agent", [source, { source }]).length, 2);
});
