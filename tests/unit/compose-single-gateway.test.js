import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// docker-compose.yml must define exactly one gateway: `888route`, published on
// host port 20129. A second gateway entry (the old `888router` service on host
// port 20128) is started by a bare `docker compose up -d` beside the live one,
// with its own separate database -- two gateways that look alike but do not
// share providers, keys or history.
const COMPOSE = readFileSync(
  fileURLToPath(new URL("../../docker-compose.yml", import.meta.url)),
  "utf8",
);
const LINES = COMPOSE.split("\n");

// Names of the two-space-indented keys under one top-level key.
function childKeys(topLevel) {
  const start = LINES.findIndex((l) => l === `${topLevel}:`);
  if (start === -1) return [];
  const keys = [];
  for (let i = start + 1; i < LINES.length; i++) {
    if (/^\S/.test(LINES[i])) break;
    const match = LINES[i].match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
    if (match) keys.push(match[1]);
  }
  return keys;
}

// Text of one service block under `services:`.
function serviceBlock(name) {
  const start = LINES.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return "";
  let end = LINES.length;
  for (let i = start + 1; i < LINES.length; i++) {
    if (/^ {2}[A-Za-z0-9_.-]+:\s*$/.test(LINES[i]) || /^\S/.test(LINES[i])) {
      end = i;
      break;
    }
  }
  return LINES.slice(start, end).join("\n");
}

const services = childKeys("services");
const gateways = services.filter((name) =>
  /^\s+image:\s*voravitl\/888router\b/m.test(serviceBlock(name)),
);
const live = serviceBlock("888route");

describe("docker-compose runs exactly one gateway, 888route on host port 20129", () => {
  it("defines one gateway service and names it 888route", () => {
    expect(gateways).toEqual(["888route"]);
  });

  it("does not define the old 888router service", () => {
    expect(services).not.toContain("888router");
  });

  it("publishes host port 20129 to the app's container port 20128", () => {
    expect(live).toMatch(/-\s*"20129:20128"/);
    expect(live).toMatch(/PORT:\s*"20128"/);
  });

  it("publishes nothing on host port 20128", () => {
    expect(COMPOSE).not.toMatch(/^\s*-\s*"?(?:[\d.]+:)?20128:\d+"?\s*$/m);
  });

  it("keeps the gateway's data on the 888route-data volume only", () => {
    expect(live).toMatch(/-\s*888route-data:\/app\/data/);
    expect(childKeys("volumes")).toEqual(["888route-data"]);
    expect(COMPOSE).not.toMatch(/888router-data/);
  });

  it("lets Watchtower update the one gateway", () => {
    expect(live).toMatch(/com\.centurylinklabs\.watchtower\.enable=true/);
    expect(serviceBlock("watchtower")).toMatch(/command:\s*\n\s*-\s*888route\s*$/m);
  });
});
