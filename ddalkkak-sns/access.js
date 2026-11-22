// Access gate (license key / 1-hour reward pass / membership), shared by the
// service worker. The endpoint is optional: with no endpoint the extension runs
// in local mode and never blocks the user, because a gate that cannot be
// verified must not brick the tool.
(() => {
  const STATE_KEY = "ddalkkakAccessState";
  const ENDPOINT_KEY = "ddalkkakAccessEndpoint";
  const DEVICE_KEY = "ddalkkakDeviceId";
  const HOUR = 60 * 60 * 1000;
  const OFFLINE_LICENSE_GRACE = 72 * HOUR;
  const DEFAULT_REWARD_URL = "https://mandooyat.com/naver_blog_ad_reward";

  async function getEndpoint() {
    const stored = await chrome.storage.local.get(ENDPOINT_KEY);
    return String(stored[ENDPOINT_KEY] || "").trim();
  }

  async function setEndpoint(url) {
    const value = String(url || "").trim();
    await chrome.storage.local.set({ [ENDPOINT_KEY]: value });
    return value;
  }

  async function getDeviceId() {
    const stored = await chrome.storage.local.get(DEVICE_KEY);
    if (stored[DEVICE_KEY]) return String(stored[DEVICE_KEY]);
    const deviceId = crypto.randomUUID();
    await chrome.storage.local.set({ [DEVICE_KEY]: deviceId });
    return deviceId;
  }

  async function readState() {
    const stored = await chrome.storage.local.get(STATE_KEY);
    return stored[STATE_KEY] && typeof stored[STATE_KEY] === "object" ? stored[STATE_KEY] : {};
  }

  async function writeState(patch) {
    const next = { ...(await readState()), ...patch, updatedAt: Date.now() };
    await chrome.storage.local.set({ [STATE_KEY]: next });
    return next;
  }

  function resolveExpiry(value) {
    const text = String(value || "").trim();
    if (!text) return 0;
    const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(text)
      ? new Date(`${text}T23:59:59.999`).getTime()
      : new Date(text).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function liveLicense(license, deviceId, now = Date.now()) {
    const verifiedAt = Number(license?.verifiedAt);
    const expiresAt = Number(license?.expiresAt);
    return Boolean(license && license.deviceId === deviceId)
      && Number.isFinite(verifiedAt) && verifiedAt > 0 && verifiedAt <= now
      && Number.isFinite(expiresAt) && expiresAt > now
      && now - verifiedAt <= OFFLINE_LICENSE_GRACE;
  }

  function livePass(pass, deviceId, now = Date.now()) {
    const issuedAt = Number(pass?.issuedAt);
    const expiresAt = Number(pass?.expiresAt);
    return Boolean(pass && pass.deviceId === deviceId && !pass.revoked)
      && Number.isFinite(issuedAt) && issuedAt <= now
      && Number.isFinite(expiresAt) && expiresAt > now
      && expiresAt - issuedAt <= HOUR + 60_000;
  }

  function liveMembership(membership, now = Date.now()) {
    const expiresAt = Number(membership?.expiresAt);
    return Boolean(membership?.valid) && Number.isFinite(expiresAt) && expiresAt > now;
  }

  // Human-readable summary used by the panel banner.
  async function summarize() {
    const now = Date.now();
    const [endpoint, deviceId, state] = await Promise.all([getEndpoint(), getDeviceId(), readState()]);
    const license = state.license;
    const pass = state.pass;
    const membership = state.membership;

    if (liveLicense(license, deviceId, now)) {
      return {
        mode: "license",
        usable: true,
        offline: !endpoint,
        configured: Boolean(endpoint),
        remainingMs: Number(license.expiresAt) - now,
        userName: String(license.userName || ""),
        expireDate: String(license.expireDate || ""),
        deviceId,
      };
    }
    if (liveMembership(membership, now)) {
      return {
        mode: "membership",
        usable: true,
        offline: !endpoint,
        configured: Boolean(endpoint),
        remainingMs: Number(membership.expiresAt) - now,
        userName: String(membership.channelHandle || "YouTube 멤버십"),
        deviceId,
      };
    }
    if (livePass(pass, deviceId, now)) {
      return {
        mode: "pass",
        usable: true,
        offline: !endpoint,
        configured: Boolean(endpoint),
        remainingMs: Number(pass.expiresAt) - now,
        userName: "1시간 무료 이용권",
        deviceId,
      };
    }
    if (!endpoint) {
      return {
        mode: "local",
        usable: true,
        offline: true,
        configured: false,
        remainingMs: 0,
        userName: "로컬 모드",
        deviceId,
      };
    }
    return {
      mode: "none",
      usable: false,
      offline: false,
      configured: true,
      remainingMs: 0,
      userName: "",
      deviceId,
    };
  }

  async function ensureAccess() {
    const summary = await summarize();
    if (summary.usable) return summary;
    const error = new Error("이용권이 없습니다. 라이선스 키를 인증하거나 광고를 보고 1시간 무료 이용권을 받아 주세요.");
    error.code = "ACCESS_REQUIRED";
    throw error;
  }

  async function requestAccess(action, payload = {}) {
    const endpoint = await getEndpoint();
    if (!endpoint) {
      const error = new Error("인증 서버 URL이 설정되지 않았습니다. 로컬 모드에서는 이 기능이 비활성화됩니다.");
      error.code = "NO_ENDPOINT";
      throw error;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, ...payload }),
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* handled below */ }
      if (data?.ok === false) return data;
      if (!response.ok) throw new Error(`인증 서버 오류 (HTTP ${response.status})`);
      if (!data || typeof data !== "object") throw new Error("인증 서버 응답을 해석하지 못했습니다.");
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("인증 서버 응답이 없습니다. 잠시 후 다시 시도하세요.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function verifyLicenseKey(licenseKey) {
    const key = String(licenseKey || "").trim();
    if (!key) throw new Error("라이선스 키를 입력하세요.");
    const deviceId = await getDeviceId();
    const result = await requestAccess("VERIFY_KEY", { licenseKey: key, deviceId });
    const data = result?.data || {};
    if (result?.ok === false || data.valid !== true) {
      await writeState({ license: null });
      throw new Error(String(result?.error || data.message || "라이선스 키가 유효하지 않습니다."));
    }
    const expiresAt = resolveExpiry(data.expireDate);
    if (!expiresAt || expiresAt <= Date.now()) {
      await writeState({ license: null });
      throw new Error("라이선스 유효기간이 만료되었습니다.");
    }
    await writeState({
      license: {
        licenseKey: key,
        deviceId,
        verifiedAt: Date.now(),
        expiresAt,
        expireDate: String(data.expireDate || ""),
        userName: String(data.userName || "사용자"),
      },
    });
    await chrome.storage.local.set({ ddalkkakLicenseKey: key });
    return summarize();
  }

  async function clearLicense() {
    await writeState({ license: null });
    await chrome.storage.local.remove("ddalkkakLicenseKey");
    return summarize();
  }

  async function openRewardPage(language) {
    const endpoint = await getEndpoint();
    if (!endpoint) {
      const error = new Error("광고 리워드는 인증 서버가 설정된 경우에만 동작합니다.");
      error.code = "NO_ENDPOINT";
      throw error;
    }
    const deviceId = await getDeviceId();
    const nonce = crypto.randomUUID();
    const languageQuery = ["ko", "en", "ja", "es"].includes(String(language || ""))
      ? `&lang=${language}`
      : "";
    const url = `${DEFAULT_REWARD_URL}?deviceId=${encodeURIComponent(deviceId)}&snsRewardSession=${nonce}${languageQuery}`;
    const tab = await chrome.tabs.create({ url, active: true });
    await writeState({ session: { nonce, tabId: tab.id, deviceId, openedAt: Date.now() } });
    return { opened: true, tabId: tab.id };
  }

  async function claimReward() {
    const state = await readState();
    const session = state.session;
    if (!session?.nonce) throw new Error("먼저 ‘광고 보고 무료 이용권 받기’를 눌러 주세요.");
    if (Date.now() - Number(session.openedAt) > HOUR) {
      throw new Error("광고 세션이 만료되었습니다. 다시 열어 주세요.");
    }
    const deviceId = await getDeviceId();
    const result = await requestAccess("CLAIM_REWARD", { deviceId, sessionNonce: session.nonce });
    const data = result?.data || {};
    if (result?.ok === false || data.valid !== true) {
      throw new Error(String(result?.error || data.message || "아직 광고 시청이 확인되지 않았습니다."));
    }
    const now = Date.now();
    const requestedExpiry = Number(data.expiresAt);
    const expiresAt = Math.min(
      Number.isFinite(requestedExpiry) && requestedExpiry > now ? requestedExpiry : now + HOUR,
      now + HOUR,
    );
    await writeState({
      session: null,
      pass: { deviceId, issuedAt: now, expiresAt, reason: "verified-pass" },
    });
    return summarize();
  }

  async function verifyMembership() {
    const deviceId = await getDeviceId();
    const result = await requestAccess("VERIFY_MEMBERSHIP", { deviceId });
    const data = result?.data || {};
    if (result?.ok === false || data.valid !== true) {
      throw new Error(String(result?.error || data.message || "YouTube 멤버십이 확인되지 않았습니다."));
    }
    const expiresAt = resolveExpiry(data.expireDate) || Date.now() + 30 * 24 * HOUR;
    await writeState({
      membership: {
        valid: true,
        deviceId,
        channelHandle: String(data.channelHandle || ""),
        tier: String(data.tier || ""),
        expiresAt,
      },
    });
    return summarize();
  }

  function formatRemaining(remainingMs) {
    const minutes = Math.max(0, Math.round(Number(remainingMs || 0) / 60000));
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest ? `${hours}시간 ${rest}분` : `${hours}시간`;
    }
    return `${minutes}분`;
  }

  globalThis.DDALKKAK_ACCESS = Object.freeze({
    getEndpoint,
    setEndpoint,
    getDeviceId,
    summarize,
    ensureAccess,
    verifyLicenseKey,
    clearLicense,
    openRewardPage,
    claimReward,
    verifyMembership,
    formatRemaining,
    liveLicense,
    livePass,
    resolveExpiry,
  });
})();
