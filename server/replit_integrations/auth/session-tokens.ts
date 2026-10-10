import type { TokenEndpointResponse, TokenEndpointResponseHelpers } from "openid-client";

export function updateUserSession(
  user: any,
  tokens: TokenEndpointResponse & TokenEndpointResponseHelpers,
) {
  const claims = tokens.claims();
  const receivedAt = Math.floor(Date.now() / 1000);
  let expiresAt: number;
  if (tokens.expires_in !== undefined) {
    if (typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in)
      || tokens.expires_in < 0) {
      throw new Error("Token response has an invalid access-token lifetime");
    }
    // expires_in describes the new access token, not the retained ID token.
    expiresAt = Math.floor(receivedAt + tokens.expires_in);
  } else if (typeof claims?.exp === "number" && Number.isFinite(claims.exp)) {
    // Compatibility for responses with fresh ID-token claims but no lifetime.
    expiresAt = Math.floor(claims.exp);
  } else {
    // Never extend access using the previous token's expiry or an invented TTL.
    throw new Error("Token response has no usable expiry");
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new Error("Token response has an invalid expiry");
  }
  if (!claims && !user.claims) {
    throw new Error("Token response has no identity claims");
  }

  // OpenID Connect permits a refresh response without an ID token.
  // Keep the identity established at sign-in when no new claims are returned.
  if (claims) user.claims = claims;
  user.access_token = tokens.access_token;
  user.access_token_received_at = receivedAt;
  // A provider may also omit refresh_token when it has not rotated it.
  if (tokens.refresh_token) user.refresh_token = tokens.refresh_token;
  user.expires_at = expiresAt;
}
