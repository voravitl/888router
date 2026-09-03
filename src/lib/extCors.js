export function getExtCorsHeaders(request) {
  const origin = request?.headers?.get?.("origin") || "";
  if (!origin) return {};
  if (origin.startsWith("chrome-extension://")) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-aipass-token",
    };
  }
  try {
    const { hostname } = new URL(origin);
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-aipass-token",
      };
    }
  } catch {}
  return {};
}

export function handleExtOptions(request) {
  return new Response(null, {
    status: 204,
    headers: getExtCorsHeaders(request),
  });
}
