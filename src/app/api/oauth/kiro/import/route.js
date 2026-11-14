import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";
import { createProviderConnection } from "@/models";

function normalizeClientSecretExpiresAt(rawExpiresAt) {
  if (typeof rawExpiresAt === "number" && Number.isFinite(rawExpiresAt) && rawExpiresAt > 0) {
    return new Date(rawExpiresAt < 1e12 ? rawExpiresAt * 1000 : rawExpiresAt).toISOString();
  }
  if (typeof rawExpiresAt === "string" && rawExpiresAt.trim()) {
    const trimmed = rawExpiresAt.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isFinite(num) && num > 0) {
        return new Date(num < 1e12 ? num * 1000 : num).toISOString();
      }
      return null;
    }
    const parsedMs = Date.parse(trimmed);
    if (Number.isFinite(parsedMs)) {
      return new Date(parsedMs).toISOString();
    }
  }
  return null;
}

/**
 * POST /api/oauth/kiro/import
 * Import and validate refresh token from Kiro IDE.
 * For IDC (organization) tokens, accepts clientId/clientSecret/region so the
 * token can be refreshed via the regional AWS OIDC endpoint.
 */
export async function POST(request) {
  try {
    const {
      refreshToken,
      clientId,
      clientSecret,
      clientSecretExpiresAt,
      region,
      authMethod,
      profileArn,
    } = await request.json();

    if (!refreshToken || typeof refreshToken !== "string") {
      return NextResponse.json(
        { error: "Refresh token is required" },
        { status: 400 }
      );
    }

    const kiroService = new KiroService();
    const isIdc = !!(clientId && clientSecret);
    const normalizedClientSecretExpiresAt = normalizeClientSecretExpiresAt(clientSecretExpiresAt);

    // For IDC tokens, refresh via the regional OIDC endpoint with client credentials.
    // For social/builder-id tokens, use the standard social refresh endpoint.
    const providerSpecificData = isIdc
      ? { clientId, clientSecret, region: region || "us-east-1", authMethod: "idc" }
      : {};

    const tokenData = await kiroService.refreshToken(refreshToken.trim(), providerSpecificData);

    const email = kiroService.extractEmailFromJWT(tokenData.accessToken);
    const resolvedAuthMethod = isIdc ? "idc" : "imported";
    const providerLabel = isIdc ? "Enterprise" : "Imported";
    const resolvedProfileArn = profileArn || tokenData.profileArn || null;

    const connection = await createProviderConnection({
      provider: "kiro",
      authType: "oauth",
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken || refreshToken.trim(),
      expiresAt: new Date(Date.now() + (tokenData.expiresIn || 3600) * 1000).toISOString(),
      email: email || null,
      providerSpecificData: {
        profileArn: resolvedProfileArn,
        authMethod: resolvedAuthMethod,
        provider: providerLabel,
        ...(isIdc
          ? {
              clientId,
              clientSecret,
              region: region || "us-east-1",
              ...(normalizedClientSecretExpiresAt
                ? { clientSecretExpiresAt: normalizedClientSecretExpiresAt }
                : {}),
            }
          : {}),
      },
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
    });
  } catch (error) {
    console.log("Kiro import token error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
