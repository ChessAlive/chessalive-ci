import { describe, expect, it } from "vitest";

import type { UserProfile } from "@chessalive/types";

import { adminEmails, canUseBetaFeatures, canUseRiskFeatures, isAdminUser } from "../AppModel";

// The local profile cache (packages/services localPersistence.profileForLocalCache) deliberately
// strips `email` as PII, so after ANY reload an owner's cached profile carries no email at all.
// isAdminUser used to match on email alone, so it went false — which hid the Admin nav and, far
// worse, the Settings "Beta features" card. A beta-on account then had no control to turn beta OFF.
// The server now stamps `isAdmin` on the own-profile (a boolean the cache keeps) and that flag is
// the primary signal.
const baseProfile = (overrides: Partial<UserProfile>): UserProfile =>
  ({
    id: "email-owner@chessalive.com",
    displayName: "owner",
    avatarEmoji: "♟",
    rating: { blitz: 400, rapid: 400, bullet: 400, daily: 400, funny: 400 },
    ...overrides,
  }) as UserProfile;

describe("isAdminUser", () => {
  it("trusts the server-stamped flag when the cached profile has no email", () => {
    const cached = baseProfile({ isAdmin: true });
    expect(cached.email).toBeUndefined();
    expect(isAdminUser(cached)).toBe(true);
  });

  it("still recognises an allowlisted email when the flag is absent (older server)", () => {
    expect(isAdminUser(baseProfile({ email: adminEmails[0] }))).toBe(true);
  });

  it("matches an allowlisted email case-insensitively and with surrounding space", () => {
    expect(isAdminUser(baseProfile({ email: `  ${adminEmails[0].toUpperCase()} ` }))).toBe(true);
  });

  it("denies an ordinary account that carries neither signal", () => {
    expect(isAdminUser(baseProfile({ email: "player@example.com" }))).toBe(false);
    expect(isAdminUser(baseProfile({}))).toBe(false);
  });

  it("never treats a non-true flag as admin", () => {
    expect(isAdminUser(baseProfile({ isAdmin: false }))).toBe(false);
    expect(isAdminUser({ ...baseProfile({}), isAdmin: "yes" } as unknown as UserProfile)).toBe(false);
  });

  it("denies a missing profile", () => {
    expect(isAdminUser(null)).toBe(false);
    expect(isAdminUser(undefined)).toBe(false);
  });
});

// The server's beta/risk allowlist is CHESSALIVE_ADMIN_EMAILS ∪ CHESSALIVE_DEPLOY_EMAILS, which is
// WIDER than the bundled adminEmails list. Deriving eligibility on the client let the two drift: a
// deploy-listed account could persist betaFeaturesEnabled (the server accepted the write) while the
// Settings card that toggles it never rendered. The server now stamps the decision.
describe("canUseBetaFeatures / canUseRiskFeatures", () => {
  it("honours the server stamp for an account outside the bundled admin list", () => {
    const deployOnly = baseProfile({ canUseBeta: true, canUseRisk: true });
    expect(isAdminUser(deployOnly)).toBe(false);
    expect(canUseBetaFeatures(deployOnly)).toBe(true);
    expect(canUseRiskFeatures(deployOnly)).toBe(true);
  });

  it("lets an explicit false stamp overrule a stale admin-email match", () => {
    const revoked = baseProfile({ email: adminEmails[0], canUseBeta: false, canUseRisk: false });
    expect(canUseBetaFeatures(revoked)).toBe(false);
    expect(canUseRiskFeatures(revoked)).toBe(false);
  });

  it("falls back to the admin check when the server sent no stamp", () => {
    expect(canUseBetaFeatures(baseProfile({ isAdmin: true }))).toBe(true);
    expect(canUseRiskFeatures(baseProfile({ isAdmin: true }))).toBe(true);
    expect(canUseBetaFeatures(baseProfile({ email: "player@example.com" }))).toBe(false);
  });

  it("denies a missing profile", () => {
    expect(canUseBetaFeatures(null)).toBe(false);
    expect(canUseRiskFeatures(undefined)).toBe(false);
  });
});
