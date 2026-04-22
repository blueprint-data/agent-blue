import crypto from "node:crypto";
import { createId } from "../../../utils/id.js";

const INTEGRATION_TOKEN_PREFIX = "abt_rt_";
const INTEGRATION_SECRET_BYTES = 32;

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function generateRepoRefreshIntegrationToken(): {
  tokenId: string;
  plaintextToken: string;
  tokenPrefix: string;
  secretHash: string;
} {
  const tokenId = createId("itok");
  const secret = crypto.randomBytes(INTEGRATION_SECRET_BYTES).toString("base64url");
  const plaintextToken = `${INTEGRATION_TOKEN_PREFIX}${tokenId}.${secret}`;
  const tokenPrefix = `${INTEGRATION_TOKEN_PREFIX}${tokenId.slice(0, 10)}`;
  return {
    tokenId,
    plaintextToken,
    tokenPrefix,
    secretHash: sha256Hex(secret)
  };
}

export function parseRepoRefreshIntegrationToken(rawToken: string): {
  tokenId: string;
  secretHash: string;
} | null {
  const token = rawToken.trim();
  if (!token.startsWith(INTEGRATION_TOKEN_PREFIX)) {
    return null;
  }

  const dotIndex = token.indexOf(".");
  if (dotIndex <= INTEGRATION_TOKEN_PREFIX.length || dotIndex === token.length - 1) {
    return null;
  }

  const tokenId = token.slice(INTEGRATION_TOKEN_PREFIX.length, dotIndex).trim();
  const secret = token.slice(dotIndex + 1).trim();
  if (!tokenId || !secret) {
    return null;
  }

  return {
    tokenId,
    secretHash: sha256Hex(secret)
  };
}
