# 📊 pi-accounts-usage — Multi-Account Codex Usage

A self-maintained Pi extension for viewing usage across named OpenAI Codex accounts
managed by `@narumitw/pi-accounts` and switching the active account without
re-authenticating.

## ✨ Features

- Registers `/accounts-usage` without replacing `/accounts` or `/usage`.
- Queries every named OpenAI Codex account concurrently.
- Shows primary and secondary windows, reset time, credits, and per-account errors.
- Persists account selection through the shared `AccountStore`.
- Never displays OAuth access or refresh tokens.
- Keeps credential loading optional and fails clearly when the companion packages are unavailable.

## 📦 Install

This package is maintained in the private Gitea repository `joe/pi-extensions` together with
our maintained `pi-accounts` and `pi-usage` packages.

For a local checkout, load `./packages/pi-accounts-usage` after installing the
repository dependencies. The package uses Pi's source entrypoint and does not
require a generated runtime bundle.

## 🚀 Quick start

Run `/accounts-usage` in an interactive Pi session.

Use `↑` and `↓` to select an account, `Enter` to switch, `R` to refresh, and
`Esc` to close.

## 🔐 Compatibility behavior

The panel reads the active provider state through the maintained
`@narumitw/pi-accounts` package and queries through the maintained
`@narumitw/pi-usage` adapter.

The extension does not implement login, credential refresh, reset redemption, or
account removal. Use `/accounts` for those account-management operations and
`/usage` for current-account usage and reset actions.

## 🗂️ Package layout

```text
packages/pi-accounts-usage/
├── src/
│   ├── accounts-usage.ts
│   └── index.ts
├── README.md
├── LICENSE
├── package.json
└── tsconfig.json
```

## 🔎 Keywords

Pi extension, Codex usage, OAuth accounts, quota, account switching.

## 📄 License

MIT.
