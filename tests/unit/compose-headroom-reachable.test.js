import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// docker-compose.yml is the live deploy path (k8s/ is inert since #501).
// headroom 0.39.1 binds 127.0.0.1 by default and guards /v1/compress to
// loopback peers, so the gateway container gets ECONNREFUSED / 404 unless the
// settings below are present. Observed live 2026-10-02 (#515): every request
// logged "[HEADROOM] skipped: request failed: ECONNREFUSED" while the
// in-container healthcheck (127.0.0.1) stayed green.
const COMPOSE = readFileSync(
  fileURLToPath(new URL("../../docker-compose.yml", import.meta.url)),
  "utf8",
);

// Text of one two-space-indented service key under `services:`.
function serviceBlock(name) {
  const lines = COMPOSE.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i]) || /^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("docker-compose headroom service is reachable from the gateway (#515)", () => {
  const headroom = serviceBlock("headroom");

  it("finds the headroom service block", () => {
    expect(headroom).toContain("image:");
  });

  it("binds all interfaces so other containers can connect", () => {
    expect(headroom).toMatch(/HEADROOM_HOST:\s*"0\.0\.0\.0"/);
  });

  it("allows /v1/compress from a non-loopback peer", () => {
    expect(headroom).toMatch(/HEADROOM_COMPRESS_ALLOW_REMOTE:\s*"1"/);
  });

  it("keeps the host port off the LAN now that the process listens on 0.0.0.0", () => {
    expect(headroom).toMatch(/-\s*"127\.0\.0\.1:8787:8787"/);
    expect(headroom).not.toMatch(/-\s*"?8787:8787"?\s*$/m);
  });

  it("gateway services reach headroom by service name, never localhost", () => {
    const urls = [...COMPOSE.matchAll(/HEADROOM_URL:\s*(\S+)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toBe("http://headroom:8787");
  });
});
