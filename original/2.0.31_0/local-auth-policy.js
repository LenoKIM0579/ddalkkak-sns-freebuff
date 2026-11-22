// Shared by the panel and service worker. No server response grants these rights.
(() => {
  const allowedTiers = Object.freeze(['딸깍 SNS 광고 제거']);
  const normalizeTier = value => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  function allowedTier(tier) {
    return allowedTiers.includes(normalizeTier(tier));
  }
  function usableMembership(session, now = Date.now()) {
    const verifiedAt = Number(session?.verifiedAt);
    const expiresAt = Number(session?.expiresAt);
    const checkedAt = Number(session?.tierPolicyCheckedAt);
    return Boolean(session && /^@[^\s/@]{2,100}$/.test(String(session.channelHandle || ''))
      && allowedTier(session.tier)
      && ['allowlist-v1', 'local-tier-v1'].includes(session.tierPolicy)
      && Number.isFinite(verifiedAt) && verifiedAt > 0 && verifiedAt <= now
      && Number.isFinite(expiresAt) && expiresAt > now && expiresAt > verifiedAt
      && expiresAt - verifiedAt <= 7 * 24 * 60 * 60 * 1000
      && Number.isFinite(checkedAt) && checkedAt > 0 && checkedAt <= now);
  }
  globalThis.ddalkkakLocalAuth = Object.freeze({ allowedTiers, allowedTier, usableMembership });
})();
