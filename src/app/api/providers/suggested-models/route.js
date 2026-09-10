import { NextResponse } from "next/server";
import { FILTERS } from "./filters.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const type = searchParams.get("type");
  // Optional provider hint so filters can fall back to local capabilities
  // (open-sse/providers/capabilities.js) when upstream omits context_length.
  // The dashboard always knows the provider id, so passing it costs nothing.
  const provider = searchParams.get("provider");
  // Accept the API key via a custom header (X-Provider-Key) so it never
  // appears in URLs / access logs / browser history (9-opus review).
  const apiKey = request.headers.get("x-provider-key");

  if (!url || !type) {
    return NextResponse.json({ error: "Missing url or type" }, { status: 400 });
  }

  const filter = FILTERS[type];
  if (!filter) {
    return NextResponse.json({ error: "Unknown filter type" }, { status: 400 });
  }

  // Public-catalog fetchers (opencode-go) use a fixed public credential and
  // must NEVER receive the caller's private key — the dashboard sends the
  // active connection's apiKey by default, which would leak it upstream.
  const isPublicCatalog = type === "opencode-go";
  try {
    const headers = { "Content-Type": "application/json" };
    if (isPublicCatalog) {
      headers.Authorization = "Bearer public";
    } else if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      return NextResponse.json({ data: [] });
    }
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    const data = filter(Array.isArray(raw) ? raw : [], provider);
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json({ data: [] });
  }
}
