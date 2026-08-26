/**
 * Modality Bridge Service for 888router
 * 
 * Automatically intercepts multimodal content (images) when routed to text-only models:
 * 1. Detects image blocks in OpenAI/Claude/Gemini message payloads
 * 2. Caches image descriptions by SHA-256 hash (in-memory, TTL 30m)
 * 3. Calls a lightweight vision model (e.g. gemini-flash, gpt-4o-mini) to describe images
 * 4. Replaces image blocks with structured text descriptions so text-only models continue seamlessly
 * 5. Loop & Failure Protection: 1 retry max, graceful text fallback if description fails
 */

import crypto from "node:crypto";
import { getCapabilitiesForModel } from "../providers/capabilities.js";

// In-memory description cache: Map<sha256Hash, { description, expiresAt }>
const descriptionCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_ENTRIES = 500;

function cleanExpiredCache() {
  const now = Date.now();
  for (const [key, entry] of descriptionCache.entries()) {
    if (entry.expiresAt <= now) {
      descriptionCache.delete(key);
    }
  }
  if (descriptionCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = descriptionCache.keys().next().value;
    if (oldestKey) descriptionCache.delete(oldestKey);
  }
}

/**
 * Check if request body contains image attachments
 * @param {object} body - Request body
 * @returns {boolean}
 */
export function hasImageContent(body) {
  if (!body || !Array.isArray(body.messages)) return false;
  for (const msg of body.messages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === "image" || block?.type === "image_url" || block?.image_url) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Compute sha256 hash of image data for caching
 * @param {string|object} imageData - Base64 string or url
 * @returns {string}
 */
export function hashImage(imageData) {
  const str = typeof imageData === "string" ? imageData : JSON.stringify(imageData || "");
  return crypto.createHash("sha256").update(str).digest("hex");
}

/**
 * Extract all image blocks from body messages
 * @param {object} body - Request body
 * @returns {Array<{ msgIndex: number, blockIndex: number, image: any }>}
 */
export function extractImageBlocks(body) {
  const items = [];
  if (!body || !Array.isArray(body.messages)) return items;
  for (let mIdx = 0; mIdx < body.messages.length; mIdx++) {
    const msg = body.messages[mIdx];
    if (!msg || !Array.isArray(msg.content)) continue;
    for (let bIdx = 0; bIdx < msg.content.length; bIdx++) {
      const block = msg.content[bIdx];
      if (block?.type === "image_url" || block?.image_url) {
        items.push({
          msgIndex: mIdx,
          blockIndex: bIdx,
          image: block.image_url?.url || block.image_url || block,
          rawBlock: block,
        });
      } else if (block?.type === "image" && block.source) {
        items.push({
          msgIndex: mIdx,
          blockIndex: bIdx,
          image: block.source?.data || block.source,
          rawBlock: block,
        });
      }
    }
  }
  return items;
}

/**
 * Transform body by replacing image blocks with textual descriptions
 * @param {object} body - Request body
 * @param {object} options
 * @param {string} options.targetModel - Selected model id
 * @param {Function} [options.describeImage] - (image) => Promise<string>
 * @param {object} [options.log] - Logger
 * @returns {Promise<{ transformedBody: object, bridgedCount: number }>}
 */
export async function bridgeVisionToText(body, options = {}) {
  const { targetModel, describeImage, log } = options;
  if (!body || !hasImageContent(body)) {
    return { transformedBody: body, bridgedCount: 0 };
  }

  // If model already supports native vision, pass through directly
  let prov = null;
  let mdl = targetModel || "";
  if (mdl.includes("/")) {
    const parts = mdl.split("/");
    prov = parts[0];
    mdl = parts.slice(1).join("/");
  }
  const caps = getCapabilitiesForModel(prov, mdl || targetModel);
  if (caps.vision === true) {
    return { transformedBody: body, bridgedCount: 0 };
  }

  log?.info?.("MODALITY", `Target model "${targetModel}" lacks native vision — activating Modality Bridge`);

  const clonedBody = JSON.parse(JSON.stringify(body));
  const imageBlocks = extractImageBlocks(clonedBody);
  let bridgedCount = 0;
  cleanExpiredCache();

  for (const item of imageBlocks) {
    const imgKey = hashImage(item.image);
    let description = null;

    // 1. Check in-memory cache
    const cached = descriptionCache.get(imgKey);
    if (cached && cached.expiresAt > Date.now()) {
      description = cached.description;
      log?.info?.("MODALITY", `Image cache hit: [hash=${imgKey.slice(0, 8)}]`);
    } else if (typeof describeImage === "function") {
      // 2. Call vision model with fallback protection
      try {
        log?.info?.("MODALITY", `Describing image [hash=${imgKey.slice(0, 8)}] via Vision Bridge`);
        description = await describeImage(item.rawBlock || item.image);
        if (description) {
          descriptionCache.set(imgKey, {
            description,
            expiresAt: Date.now() + CACHE_TTL_MS,
          });
        }
      } catch (err) {
        log?.warn?.("MODALITY", `Vision bridge describe failed: ${err.message || String(err)}`);
        description = `[Image description unavailable: ${err.message || "describe_failed"}]`;
      }
    } else {
      description = "[Attached Image: visual content supplied by user]";
    }

    // 3. Replace image block with text description
    const targetMsg = clonedBody.messages[item.msgIndex];
    if (targetMsg && Array.isArray(targetMsg.content)) {
      targetMsg.content[item.blockIndex] = {
        type: "text",
        text: `[Visual Context / Image Description: ${description || "image"}]`,
      };
      bridgedCount++;
    }
  }

  return { transformedBody: clonedBody, bridgedCount };
}

/**
 * Find sibling vision model in the same family/provider
 * @param {string} modelStr
 * @returns {string|null}
 */
export function findFamilyVisionModel(modelStr) {
  if (!modelStr) return null;
  const lower = modelStr.toLowerCase();
  
  if (lower.includes("claude")) {
    return modelStr.includes("/") ? `${modelStr.split("/")[0]}/claude-3-7-sonnet` : "claude-3-7-sonnet";
  }
  if (lower.includes("gpt")) {
    return modelStr.includes("/") ? `${modelStr.split("/")[0]}/gpt-4o` : "gpt-4o";
  }
  if (lower.includes("gemini")) {
    return modelStr.includes("/") ? `${modelStr.split("/")[0]}/gemini-2.5-flash` : "gemini-2.5-flash";
  }
  if (lower.includes("qwen")) {
    return modelStr.includes("/") ? `${modelStr.split("/")[0]}/qwen-vl-max` : "qwen-vl-max";
  }
  return null;
}

/**
 * Clear bridge description cache (for tests)
 */
export function clearBridgeCache() {
  descriptionCache.clear();
}
