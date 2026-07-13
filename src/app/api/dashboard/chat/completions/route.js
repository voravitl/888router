import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";

let initialized = false;

/**
 * Dashboard Test Chat endpoint.
 *
 * Same handler as /v1/chat/completions, but under /api/* so the guard uses
 * dashboard session auth (JWT or requireLogin=false) instead of the public
 * LLM "API key for remote access" rule. Needed because Docker port-publish
 * makes host→container peers look non-loopback, so /v1 rejects unauthenticated
 * browser calls even when the user is already on the dashboard.
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function POST(request) {
  await ensureInitialized();
  return await handleChat(request);
}
