<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-26 | Updated: 2026-09-26 -->

# cli

## Purpose
Launcher package published to npm as `9router`: installs/starts the gateway server, manages the system tray, and provides a terminal UI for providers, combos, API keys, and settings. Own `package.json`, version, and build — versioned independently from the repo root.

## Key Files
| File | Description |
|------|-------------|
| `cli.js` | CLI entry point |
| `package.json` | Launcher package manifest (independent version) |
| `README.md` | Launcher usage docs |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/cli/` | CLI source: `terminalUI.js` entry, `api/`, `menus/`, `tray/`, `utils/` |
| `hooks/` | Install hooks: postinstall, sqlite/tray runtime |
| `scripts/` | Build scripts: `build-cli.js`, `buildMitm.js`, HUD provider |

## For AI Agents

### Working In This Directory
- Versioned independently from root `package.json`; bump separately and keep `CHANGELOG` scope to the launcher.
- Build from repo root via `npm run cli:pack`; watch mode via `npm run dev` inside `cli/`.
- Tray code is platform-specific (`tray.js`, `trayWin.js`, `tray.ps1`) — test on the target OS.

### Testing Requirements
- Launcher changes verified by packing and installing locally before publish.

## Dependencies

### Internal
- Repo-root gateway server (the thing being launched)

### External
- Node.js, platform tray APIs

<!-- MANUAL: -->
