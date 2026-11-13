# 888router Design System — Monochrome Proof & Precision Slate

> **Direction**: `digital-design-canon-monochrome-product-marketing`  
> **UI Foundation**: Ant Design v6 (`6.7.0`) + Tailwind CSS v4 (`@custom-variant dark`)  
> **Status**: Implemented across Login, Sidebar Rail, Usage & Live Traces, Routing Topology, Gateway & Keys, AI Providers, Combos, and Test Chat.

---

## 1. Visual Thesis

An archival-neutral AI Gateway Control Plane inspired by Clarivo-style workflow cards and monochrome operational tooling. Chrome steps back into disciplined light paper or obsidian slate surfaces so traffic telemetry, combo routing hops, and active provider health read in seconds without decorative neon or multi-hue clutter.

---

## 2. Color Architecture (`src/app/globals.css`)

### Light Palette (`:root`)
| Token | Hex | Role |
| :--- | :--- | :--- |
| `--color-bg` | `#fafafa` | Main page canvas & sidebar (`--color-sidebar`) |
| `--color-bg-alt` | `#f2f2f2` | Subtle stat bars & table sub-headers |
| `--color-surface` | `#ffffff` | Primary cards, containers, draw panels |
| `--color-surface-2` | `#f4f4f4` | Inset pills, code blocks, secondary tiles |
| `--color-surface-3` | `#e6e6e6` | Hover / active fill inside muted controls |
| `--color-border` | `#e2e2e2` | Card frames and primary structural dividers |
| `--color-border-subtle` | `#efefef` | Row hairlines & cell separators |
| `--color-text` / `--color-text-main` | `#111111` | Primary headings, body copy, numeric KPIs |
| `--color-text-muted` | `#6b6b6b` | Secondary labels, timestamps, metadata |
| `--color-text-subtle` | `#a6a6a6` | Placeholders, disabled labels |
| `--color-primary` | `#111111` | Solid high-contrast primary CTAs & selected chips |

### Dark Palette (`.dark`)
Synchronized between CSS variables and Ant Design `theme.darkAlgorithm` via Zustand `useThemeStore` (`AntdProvider.js`).
| Token | Hex | Role |
| :--- | :--- | :--- |
| `--color-bg` | `#0a0a0b` | Obsidian canvas & sidebar (`--color-sidebar`) |
| `--color-bg-alt` | `#111114` | Stat rails & toolbar wells |
| `--color-surface` | `#121215` | Primary surface cards |
| `--color-surface-2` | `#18181c` | Inset badges & control wells |
| `--color-surface-3` | `#242429` | Active hover fills |
| `--color-border` | `#26262c` | Card & table hairline borders |
| `--color-border-subtle` | `#1c1c21` | Internal grid dividers |
| `--color-text` / `--color-text-main` | `#fafafa` | Primary light-on-dark typography |
| `--color-primary` | `#fafafa` | Inverted monochrome primary CTA |

### Operational Accent & Semantic Quarantine
| Token | Hex | Strict Usage Boundary |
| :--- | :--- | :--- |
| `--color-olive` | `#a6c23f` | **Sole live operational accent**: active gateway dots, SVG animated flow paths, cache hit ratio segments |
| `--color-danger` | `#dc2626` | **Quarantined**: error HTTP badges, circuit-broken/expired credential state |
| `--color-warning` | `#d97706` | Cooldown timers, security advisories |
| `--color-success` | `#16a34a` | Non-olive explicit success confirmations where semantic text is required |

---

## 3. Typography, Hierarchy & Geometry

- **UI Sans**: `Inter` (`font-semibold` tracking `-0.025em` for page headers)
- **Data / Monospace**: `JetBrains Mono` (`tabular-nums` for request counts, tokens, latency, share percentages, and `provider/model` slugs)
- **Radius Scale**: `--radius-brand: 8px` (`rounded-lg`) for controls/badges, `--radius-brand-lg: 10px` (`rounded-xl`) for PageHero and container cards
- **Elevation**: Border-first hierarchy (`1px solid var(--color-border)` + `0 1px 2px rgba(0,0,0,0.04)` light; flat border-only dark), reserving elevated shadows exclusively for drawers and command modals

---

## 4. Core Component Architecture

### `PageHero` (`src/shared/components/PageHero.js`)
Unified header pattern across Combos, Providers, and Usage:
- Left icon badge + title + optional olive live counter pill + 1-line summary
- Wrapping action bar (`min-w-0 max-w-full`) preventing right-edge clipping at `390px`
- Optional 4-column `stats` rail (`divide-x divide-border-subtle`) and bottom filter `toolbar`

### `ProviderTopology` — 3-Stage Directed Gateway Flow Map (`src/app/(dashboard)/dashboard/usage/components/ProviderTopology.js`)
Completely replaces legacy radial ReactFlow (`@xyflow/react`) circles with a horizontal linear signal bus:
1. **Stage 1 — Ingress Channels**: Client endpoints routing into the gateway (`v1/chat/completions`, `v1/messages`, `v1/responses`)
2. **Stage 2 — Policy Core**: High-contrast solid monochrome switch (`#111111` light / `#fafafa` dark) summarizing active routing paths & total request throughput
3. **Stage 3 — Upstream Targets**: Ranked provider nodes with real-time share bars (`%`), request counts, active olive pulse dots, and collapsible standby pool
- **Dynamic SVG Bezier Bus**: Measures exact port coordinates via `ResizeObserver` + `getBoundingClientRect()` and renders dashed `.mono-flow-dash` paths (`#a6c23f` on active selection)
- **Interactive Modes**: Toggle `Flow | Paths` matrix view and click any ingress/upstream node to inspect exact share and latency details in the micro-inspector footer

### `Model Combo Pipelines` (`src/app/(dashboard)/dashboard/combos/page.js`)
2-column Clarivo-inspired workflow studio featuring numbered vertical/horizontal step pipeline nodes (`01`, `02`, `03` + weighted `%` chips), inline strategy selector, strategy guide drawer, and `ComboLocksPanel` for circuit-broken hops.

### `AI Providers` (`src/app/(dashboard)/dashboard/providers/page.js`)
Ant Design `Table` (`size="small"`, `bordered`, `scroll={{ x: 760 }}`) catalog supporting `Matrix | Cards` view switch, category `Segmented` filters, inline toggle/batch-test controls, and slide-over `Drawer` connection inspector.

### `Gateway & Keys` (`src/app/(dashboard)/dashboard/endpoint/components/HyperionBentoHero.js`)
4-up monochrome KPI strip, 10-minute Recharts `BarChart` telemetry (`YAxis` non-zero headroom + live SSE updates), SDK/CLI quickstart tabs (`cURL`, `Claude Code`, `Codex`, `Cursor`, `OpenCode`), and scoped virtual API key management.
