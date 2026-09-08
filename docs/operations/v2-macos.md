# Personal V2 Mac build

This fork branch builds `T3 Code V2 (Alpha).app` alongside the official app. It uses a teal V2 icon and does not subscribe to official desktop updates.

V2 starts with an empty application history. Its database, settings, attachments, logs, caches, and worktrees live under `~/.t3-v2`. Electron stores browser sessions and local storage under `~/Library/Application Support/t3code-v2`. V2 does not migrate the original app's data. Git checkpoints use the separate `refs/t3-v2/` namespace inside project repositories. Provider logins, configuration, and provider-owned session files such as `~/.codex` and `~/.claude` remain shared, as do project directories you choose to open.

Use `T3CODE_V2_HOME` to override V2's data directory. The original `T3CODE_HOME` variable is ignored. Linked development worktrees use their own `.t3-v2`. SSH launcher state and WSL runtime caches also use `.t3-v2` on their respective hosts. An explicitly selected remote environment still owns its own data.

Build on an Apple Silicon Mac with Node 24 and Rust 1.95 or newer:

```sh
vp i
vp run dist:desktop:dmg:arm64 --output-dir ~/Downloads/T3-Code-V2
```

Open the resulting DMG and copy `T3 Code V2 (Alpha).app` to Applications. Local builds are not notarized. Future updates require rebuilding this branch.

The icon source is `assets/v2/app-icon.svg`. To regenerate its PNG from the repository root:

```sh
node --input-type=module -e 'import sharp from "./scripts/node_modules/sharp/lib/index.js"; await sharp("assets/v2/app-icon.svg").png().toFile("assets/v2/app-icon.png")'
```
