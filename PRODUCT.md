# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Solo developer / AI Operator running `888router` locally on macOS via Docker Compose (`http://localhost:20129`) as a unified AI gateway behind daily AI coding and chat tools (Claude Code, Codex, Cursor, OpenCode, Cline, Antigravity, etc.).

## Product Purpose

Route LLM API requests reliably across subscription accounts, free tiers, and paid API keys from a single local endpoint, while giving the operator immediate visibility into live request streams, 429 rate-limit fallbacks, quota headroom, token compression savings (RTK), and estimated spend.

## Positioning

Local-first unified AI proxy & failover control plane with built-in OAuth/free-tier credential pooling, automated multi-provider fallback combos, RTK tool-result token compression, and real-time SSE usage/log inspection — under clean `888router` ownership without external cloud/SaaS upsells.

## Operating Context

- Self-hosted Docker Compose container (`888route`) on port `20129` reading local SQLite storage.
- Operator opens the dashboard primarily to:
  1. Inspect **Live Logs, Traces & Cost Analytics** (spot latency spikes, `429` rate limits, token burn, cache hit rates, and fallback behavior).
  2. Monitor **Providers & Real-time Quota** (see which accounts are healthy/throttled/cooled down and add or refresh credentials).
  3. Orchestrate **Combos & Failover Routing** (chain primary -> fallback models, configure auto-combos and strategy locks).
  4. Copy **Endpoint Keys & Sync CLI Tools** (issue virtual API keys and wire Claude Code / Codex / Cursor endpoints cleanly).
- Every existing route and functional capability across `/dashboard/endpoint`, `/dashboard/providers`, `/dashboard/combos`, `/dashboard/usage`, `/dashboard/quota`, `/dashboard/console-log`, `/dashboard/cli-tools`, `/dashboard/proxy-pools`, `/dashboard/token-saver`, `/dashboard/translator`, `/dashboard/mitm`, `/dashboard/skills`, `/dashboard/media-providers`, `/dashboard/basic-chat`, and `/dashboard/profile` must continue to work 100%.

## Capabilities and Constraints

- Stack: Next.js 16 App Router, React 19, Ant Design `6.7.0` (`@ant-design/nextjs-registry`), Zustand theme store (dark & light modes), Tailwind CSS.
- Real-time data: `/api/usage/stats`, `/api/usage/stream` (SSE), `/api/providers`, `/api/combos`, `/api/keys`, quota & log endpoints.
- Hard constraint: No `9Remote` references, no donation/upsell banners, no hardcoded mock telemetry.
- Must remain verifiable through the full Vitest suite (`tests/vitest.config.js`) and Next.js production build.

## Brand Commitments

- Name: `888router` (`AI Routing Control Plane`).
- Zero third-party promo chrome (`9Remote` and donation links permanently removed).

## Product Principles

1. Show live operational truth (logs, quota, failover state, spend) in the first viewport before chrome.
2. Preserve 100% functional parity across all provider OAuth flows, combo pipelines, keys, and diagnostic tools.
3. Make inspection non-disruptive — drill into request traces, provider details, and combo hops without losing workspace context.
