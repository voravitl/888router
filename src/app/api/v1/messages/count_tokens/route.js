import { estimateRequestTokens } from "../../../../../../open-sse/services/requestContext.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

export const estimateAnthropicInputTokens = estimateRequestTokens;

/**
 * POST /v1/messages/count_tokens - Approximate token count response (not a provider tokenizer)
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }

  const inputTokens = estimateAnthropicInputTokens(body);

  return new Response(JSON.stringify({
    input_tokens: inputTokens
  }), {
    headers: { "Content-Type": "application/json", "X-888-Token-Count-Method": "estimate", ...CORS_HEADERS }
  });
}

