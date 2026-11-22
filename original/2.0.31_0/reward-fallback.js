// Additive reward protocol. Existing VERIFY_KEY / BUILD_BLOG_PROMPT stay compatible.
const REWARD_STATE_KEY = 'snsRewardContinuityV1';
const REWARD_HOUR = 60 * 60 * 1000;
const PAID_LICENSE_OUTAGE_GRACE_MS = 72 * REWARD_HOUR;
let rewardQueue = Promise.resolve();
let gasUnavailableUntil = 0;
const paidVerificationRequests = new Map();
const localMonitorReceipts = new Set();

// Best-effort monitoring only. An old GAS deployment may reject this new action;
// no response (including rejection) can change local access or its expiry.
function reportLocalAuthEvent(deviceId, payload) {
  const event = String(payload?.event || '');
  if (!['ad-pass', 'membership'].includes(event) || !deviceId) return;
  const record = { event, issuedAt: Number(payload.issuedAt), expiresAt: Number(payload.expiresAt),
    tier: String(payload.tier || '').slice(0, 100) };
  const identity = JSON.stringify([deviceId, record]);
  if (localMonitorReceipts.has(identity)) return;
  localMonitorReceipts.add(identity);
  if (localMonitorReceipts.size > 50) localMonitorReceipts.delete(localMonitorReceipts.values().next().value);
  void (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(GAS_BACKEND_URL, {
        method: 'POST', headers: {'Content-Type': 'text/plain;charset=utf-8'},
        body: JSON.stringify({action: 'RECORD_LOCAL_AUTH_EVENT', deviceId, payload: record}),
        redirect: 'follow', cache: 'no-store', signal: controller.signal,
      });
      const result = JSON.parse(await response.text());
      if (!response.ok || !result?.ok) throw new Error('Monitoring endpoint unavailable or unsupported.');
    } catch (error) {
      if (typeof appendBackgroundDebugLog === 'function') {
        void appendBackgroundDebugLog('auth.monitor.failed', {event, error: error?.message || String(error)}).catch(() => {});
      }
    } finally { clearTimeout(timer); }
  })().catch(() => {});
}
function serializeReward(task) {
  const next = rewardQueue.then(task, task);
  rewardQueue = next.catch(() => {});
  return next;
}
async function readRewardState() {
  return (await chrome.storage.local.get(REWARD_STATE_KEY))[REWARD_STATE_KEY] || {};
}
async function saveRewardState(value) {
  await chrome.storage.local.set({[REWARD_STATE_KEY]: value});
}
function liveReward(pass, deviceId, now = Date.now()) {
  return !!pass && !pass.revoked && pass.deviceId === deviceId
    && Number.isFinite(pass.issuedAt) && Number.isFinite(pass.expiresAt)
    && pass.issuedAt <= now && pass.expiresAt > now
    && pass.expiresAt <= pass.issuedAt + REWARD_HOUR;
}
function resolvePaidLicenseExpiry(expireDate) {
  const text = String(expireDate || '').trim();
  if (!text) return 0;
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T23:59:59.999`).getTime()
    : new Date(text).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}
function livePaidLicense(proof, request, now = Date.now()) {
  const verifiedAt = Number(proof?.verifiedAt);
  const expiresAt = Number(proof?.expiresAt);
  return request?.action === 'VERIFY_KEY' && !!request.licenseKey
    && proof?.licenseKey === request.licenseKey && proof?.deviceId === request.deviceId
    && Number.isFinite(verifiedAt) && verifiedAt <= now
    && now - verifiedAt <= PAID_LICENSE_OUTAGE_GRACE_MS
    && Number.isFinite(expiresAt) && expiresAt > now;
}
function localPaidLicenseResponse(proof, now = Date.now()) {
  const remainingHours = Math.max(1, Math.ceil((proof.verifiedAt + PAID_LICENSE_OUTAGE_GRACE_MS - now) / REWARD_HOUR));
  return {ok: true, data: {valid: true, authType: 'license', userName: proof.userName || '사용자',
    expireDate: proof.expireDate, expiresAt: proof.expiresAt, offlineLicense: true,
    deviceStatusMessage: `인증 서버 연결 지연 · 오프라인 인증 유예 중 (최대 약 ${remainingHours}시간)`}};
}
async function rememberPaidLicense(data, request, state, now = Date.now()) {
  const expiresAt = resolvePaidLicenseExpiry(data?.expireDate);
  if (!expiresAt || expiresAt <= now) return;
  state = await readRewardState();
  state.license = {licenseKey: request.licenseKey, deviceId: request.deviceId, verifiedAt: now,
    expiresAt, expireDate: String(data.expireDate || ''), userName: String(data.userName || '사용자')};
  await saveRewardState(state);
}
async function forgetPaidLicense(request, state) {
  state = await readRewardState();
  if (state.license?.licenseKey !== request.licenseKey || state.license?.deviceId !== request.deviceId) return;
  delete state.license;
  await saveRewardState(state);
}
async function rememberVerifiedFreePass(responseData, state, deviceId, now = Date.now()) {
  const exactExpiry = Number(responseData?.expiresAt);
  const legacyMinutes = String(responseData?.deviceStatusMessage || '').match(/남은 시간:\s*약\s*(\d+)분/);
  const approximateExpiry = legacyMinutes
    ? now + Math.min(60, Math.max(0, Number(legacyMinutes[1]) || 0)) * 60 * 1000
    : 0;
  let expiresAt = Number.isFinite(exactExpiry) && exactExpiry > now ? exactExpiry : approximateExpiry;
  if (!expiresAt || expiresAt <= now) return null;

  const existing = liveReward(state.pass, deviceId, now) ? state.pass : null;
  if (existing) expiresAt = Math.min(existing.expiresAt, expiresAt);
  state.pass = {
    deviceId,
    issuedAt: existing?.issuedAt || now,
    expiresAt,
    temporary: false,
    reason: existing?.reason || 'verified-free-pass',
  };
  await saveRewardState(state);
  return state.pass;
}
function requirePanelSender(sender) {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('sidepanel.html')) {
    throw new Error('Reward request must originate from the extension panel.');
  }
}
async function openRewardSession(sender, language) {
  requirePanelSender(sender);
  const {deviceId} = await chrome.storage.local.get('deviceId');
  if (!deviceId) throw new Error('Device ID is missing.');
  const data = await readRewardState();
  // Open the actual ad page first; never make opening it wait for the probe.
  const nonce = crypto.randomUUID();
  const languageQuery = ['ko','en','ja','es'].includes(language) ? `&lang=${language}` : '';
  const tab = await chrome.tabs.create({url: `https://mandooyat.com/naver_blog_ad_reward?deviceId=${encodeURIComponent(deviceId)}&snsRewardSession=${nonce}${languageQuery}`, active: true});
  data.session = {nonce, tabId: tab.id, deviceId, openedAt: Date.now()};
  await saveRewardState(data);
  if (await rewardWebsiteUnavailable() && !(await rewardPageLoaded(tab.id, nonce))) {
    const now = Date.now();
    if (liveReward(data.pass, deviceId, now)) return {opened: true, emergency: true, pass: data.pass};
    data.pass = {deviceId, issuedAt: now, expiresAt: now + REWARD_HOUR, temporary: true, reason: 'reward-site-unavailable'};
    delete data.session;
    await saveRewardState(data);
    return {opened: true, emergency: true, pass: data.pass};
  }
  return {opened: true};
}
async function rewardPageLoaded(tabId, nonce) {
  try {
    const results = await chrome.scripting.executeScript({target: {tabId}, args: [nonce], func: expected => {
      const url = new URL(location.href);
      return url.origin === 'https://mandooyat.com' && url.pathname === '/naver_blog_ad_reward'
        && url.searchParams.get('snsRewardSession') === expected
        && !!document.getElementById('claimBtn') && !!document.getElementById('statusBox');
    }});
    return results.some(result => result.frameId === 0 && result.result === true);
  } catch { return false; }
}
async function rewardWebsiteUnavailable() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    // Do not send device identifiers, load ads or call the claim endpoint during the probe.
    const response = await fetch('https://mandooyat.com/naver_blog_ad_reward', {
      method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'follow', signal: controller.signal,
    });
    if (response.status >= 500 && response.status <= 599) return true;
    if (!response.ok) throw new Error(`Reward page HTTP ${response.status}`);
    await response.text();
    return false;
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) return true;
    throw error;
  } finally { clearTimeout(timer); }
}
function checkRewardSender(sender, session, nonce) {
  let url;
  try { url = new URL(sender.url); } catch { return false; }
  return !!session && sender.id === chrome.runtime.id && sender.frameId === 0
    && sender.tab?.id === session.tabId && nonce === session.nonce
    && url.origin === 'https://mandooyat.com' && url.pathname === '/naver_blog_ad_reward'
    && url.searchParams.get('snsRewardSession') === session.nonce
    && url.searchParams.get('deviceId') === session.deviceId
    && Date.now() >= session.openedAt && Date.now() - session.openedAt < REWARD_HOUR;
}
async function requestRewardGas(request) {
  const startedAt = Date.now();
  let httpStatus = null;
  let applicationOk = null;
  let failure = '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(GAS_BACKEND_URL, {
      method: 'POST', headers: {'Content-Type': 'text/plain;charset=utf-8'},
      body: JSON.stringify(request), redirect: 'follow', cache: 'no-store', signal: controller.signal,
    });
    httpStatus = response.status;
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch {}
    applicationOk = typeof data?.ok === 'boolean' ? data.ok : null;
    // An explicit application rejection is never an outage, even on a 5xx response.
    if (data?.ok === false) return data;
    if (response.status === 429 || response.status >= 500 || (response.ok && typeof data?.ok !== 'boolean')) {
      const error = new Error('Apps Script temporarily unavailable.');
      error.gasUnavailable = true;
      throw error;
    }
    if (!response.ok) throw new Error(`Apps Script HTTP ${response.status}`);
    return data;
  } catch (error) {
    failure = error?.message || String(error);
    if (error.name === 'AbortError' || error instanceof TypeError) error.gasUnavailable = true;
    if (error.gasUnavailable) gasUnavailableUntil = Date.now() + 60000;
    throw error;
  } finally {
    clearTimeout(timer);
    if (typeof appendBackgroundDebugLog === 'function') {
      void Promise.resolve(appendBackgroundDebugLog('auth.server.request.finished', {
        action: request.action, durationMs: Date.now() - startedAt,
        httpStatus, applicationOk, timedOut: controller.signal.aborted, error: failure,
      })).catch(() => {});
    }
  }
}
async function claimRewardSession(message, sender) {
  const data = await readRewardState();
  if (!checkRewardSender(sender, data.session, message.nonce)) throw new Error('Invalid or expired reward page session.');
  const session = data.session;
  const now = Date.now();
  // Repeated clicks and reloads reuse the same receipt, never a new expiry.
  if (session.claimed) {
    if (liveReward(data.pass, session.deviceId, now)) return {pass: data.pass};
    throw new Error('This reward session has already been used.');
  }
  data.pass = {deviceId: session.deviceId, issuedAt: now, expiresAt: now + REWARD_HOUR,
    temporary: false, reason: 'local-ad-pass'};
  session.claimed = true;
  await saveRewardState(data);
  reportLocalAuthEvent(session.deviceId, {event: 'ad-pass', ...data.pass});
  return {pass: data.pass};
}
function localRewardResponse(request, pass) {
  if (request.action === 'BUILD_BLOG_PROMPT') {
    return {ok: true, data: {...buildOfflineBlogPrompt(request.payload || {}), localAuth: true, offlineReward: true, expiresAt: pass.expiresAt}};
  }
  return {ok: true, data: {valid: true, authType: 'free-pass', userName: '광고 시청 1시간 무료 패스',
    expireDate: new Date(pass.expiresAt).toISOString(), expiresAt: pass.expiresAt, localAuth: true, offlineReward: true,
    deviceStatusMessage: `🎁 1시간 무료 이용권 적용 중 (남은 시간: 약 ${Math.ceil((pass.expiresAt - Date.now()) / 60000)}분)`}};
}
async function callGasWithRewardContinuity(request) {
  if (request.action === 'RECORD_LOCAL_AUTH_EVENT') {
    const device = (await chrome.storage.local.get('deviceId')).deviceId;
    if (request.deviceId !== device) return {ok: false, error: 'Device ID mismatch.'};
    reportLocalAuthEvent(device, request.payload);
    return {ok: true, data: {localAuth: true, monitoringQueued: true}};
  }
  if (request.action === 'VERIFY_KEY' && request.licenseKey) {
    const identity = JSON.stringify([request.deviceId, request.licenseKey]);
    if (paidVerificationRequests.has(identity)) return paidVerificationRequests.get(identity);
    const pending = performGasWithRewardContinuity(request);
    paidVerificationRequests.set(identity, pending);
    try { return await pending; } finally {
      if (paidVerificationRequests.get(identity) === pending) paidVerificationRequests.delete(identity);
    }
  }
  return performGasWithRewardContinuity(request);
}
async function performGasWithRewardContinuity(request) {
  const data = await readRewardState();
  const device = (await chrome.storage.local.get('deviceId')).deviceId;
  if (['CHECK_YOUTUBE_MEMBERSHIP_TIER', 'RECORD_YOUTUBE_MEMBERSHIP'].includes(request.action)) {
    const allowed = globalThis.ddalkkakLocalAuth.allowedTier(request.payload?.tier);
    return {ok: true, data: {localAuth: true, tierPolicy: 'local-tier-v1', allowed, valid: allowed}};
  }
  const eligible = !request.licenseKey && request.deviceId === device && liveReward(data.pass, device);
  const paidEligible = request.deviceId === device && livePaidLicense(data.license, request);
  if (!request.licenseKey && ['VERIFY_KEY', 'BUILD_BLOG_PROMPT'].includes(request.action)) {
    if (eligible) return localRewardResponse(request, data.pass);
    return {ok: false, error: '라이선스 키를 입력하시거나, 광고를 시청하여 1시간 무료 이용권을 받으세요.'};
  }
  if (paidEligible && gasUnavailableUntil > Date.now()) return localPaidLicenseResponse(data.license);
  try {
    const result = await requestRewardGas(request);
    if (request.action === 'VERIFY_KEY' && request.licenseKey) {
      if (result?.ok && result?.data?.valid && result.data.authType === 'license') {
        await rememberPaidLicense(result.data, request, data);
      } else {
        await forgetPaidLicense(request, data);
      }
    }
    return result;
  } catch (error) {
    if (error.gasUnavailable && livePaidLicense(data.license, request)) return localPaidLicenseResponse(data.license);
    throw error;
  }
}
