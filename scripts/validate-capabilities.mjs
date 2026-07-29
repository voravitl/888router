#!/usr/bin/env node
/**
 * Cross-reference our PATTERN_CAPABILITIES against models.dev/api.json
 * Focuses on models ACTUALLY REGISTERED in our provider registry.
 */
import { getCapabilitiesForModel } from "../open-sse/providers/capabilities.js";
import REGISTRY from "../open-sse/providers/registry/index.js";

// 1. Collect all model IDs from our registry
const ourModels = new Set();
for (const provider of REGISTRY) {
  for (const m of provider.models || []) {
    const id = m.upstreamModelId || m.id;
    ourModels.add(id);
    // Also add base name (strip vendor prefix)
    if (id.includes("/")) ourModels.add(id.split("/").pop());
  }
}
console.log(`\n📦 Our registry: ${ourModels.size} unique model IDs\n`);

// 2. Fetch models.dev
const resp = await fetch("https://models.dev/api.json");
const data = await resp.json();

// 3. Build models.dev lookup
const devModels = new Map();
for (const [pk, pv] of Object.entries(data)) {
  if (!pv || typeof pv !== "object") continue;
  const models = pv.models;
  if (!models || typeof models !== "object") continue;
  for (const [mk, mv] of Object.entries(models)) {
    if (!mv || typeof mv !== "object") continue;
    const id = mv.id || mk;
    const baseId = id.includes("/") ? id.split("/").pop() : id;
    const ctx = mv.limit?.context;
    const out = mv.limit?.output;
    const inputMods = mv.modalities?.input || [];
    const vision = Array.isArray(inputMods) && inputMods.includes("image");
    const reasoning = mv.reasoning === true;
    if (ctx && !devModels.has(baseId)) {
      devModels.set(baseId, { ctx, out, vision, reasoning, provider: pk });
    }
  }
}

// 4. Cross-reference: check our registered models against models.dev
const mismatches = [];
for (const modelId of ourModels) {
  const devData = devModels.get(modelId);
  if (!devData) continue; // Not in models.dev

  // Resolve using our own system (no provider context — pattern match)
  const ourCaps = getCapabilitiesForModel(null, modelId);
  const ourCtx = ourCaps.contextWindow;
  const devCtx = devData.ctx;

  const ratio = Math.abs(ourCtx - devCtx) / Math.max(ourCtx, devCtx);
  const visionMismatch = ourCaps.vision !== devData.vision;
  
  if (ratio > 0.15 || visionMismatch) {
    mismatches.push({
      model: modelId,
      ourCtx,
      devCtx,
      ourVision: ourCaps.vision,
      devVision: devData.vision,
      ourReasoning: ourCaps.reasoning,
      devReasoning: devData.reasoning,
      ratio: (ratio * 100).toFixed(0),
      visionMismatch,
    });
  }
}

mismatches.sort((a, b) => parseFloat(b.ratio) - parseFloat(a.ratio));

console.log(`🔍 Cross-referenced ${ourModels.size} models against ${devModels.size} models.dev entries\n`);

if (mismatches.length > 0) {
  console.log(`❌ MISMATCHES IN REGISTERED MODELS (${mismatches.length}):\n`);
  console.log("Model".padEnd(45) + "OurCtx".padStart(10) + "DevCtx".padStart(10) + "  Diff%  Issues");
  console.log("-".repeat(100));
  for (const m of mismatches) {
    const issues = [];
    if (parseFloat(m.ratio) > 15) issues.push(`ctx: ${m.ourCtx}→${m.devCtx}`);
    if (m.visionMismatch) issues.push(`vision: ${m.ourVision}→${m.devVision}`);
    console.log(
      `${m.model.padEnd(45)}${String(m.ourCtx).padStart(10)}${String(m.devCtx).padStart(10)}  ${m.ratio.padStart(4)}%  ${issues.join(", ")}`
    );
  }
} else {
  console.log("✅ All registered models match models.dev!");
}
console.log("");
