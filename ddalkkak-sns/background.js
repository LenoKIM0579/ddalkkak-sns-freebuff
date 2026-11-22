// Service worker: opens/reuses an AI web tab, asks its content script to send a
// prompt, and writes the result into the connected blog / SNS editor.
importScripts("access.js");

const PROVIDER_URLS = {
  gemini: "https://gemini.google.com/app",
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/new",
};
const PROVIDER_TITLES = { gemini: "Gemini", chatgpt: "ChatGPT", claude: "Claude" };
const SESSION_KEY = "ddalkkakSession";
const DEBUG_LOG_KEY = "ddalkkakDebugLog";
const DEBUG_LOG_LIMIT = 400;

void configureSidePanelBehavior();
chrome.runtime.onInstalled.addListener(() => void configureSidePanelBehavior());
chrome.runtime.onStartup.addListener(() => void configureSidePanelBehavior());

chrome.action.onClicked.addListener((tab) => {
  void openPanel(tab).catch((error) => console.error("Failed to open side panel:", error));
});

async function configureSidePanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch { /* older Chrome builds ignore this */ }
}

async function openPanel(tab) {
  if (!tab?.id) throw new Error("현재 탭을 찾지 못했습니다.");
  if (resolveEditorKind(tab.url || "")) await updateSession({ boundTabId: tab.id });
}

/* ---------------------------------------------------------------- session -- */

async function readSession() {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return stored[SESSION_KEY] || {};
}

async function updateSession(patch) {
  const next = { ...(await readSession()), ...patch };
  await chrome.storage.session.set({ [SESSION_KEY]: next });
  return next;
}

async function panelContext() {
  const session = await readSession();
  let boundTab = null;
  if (session.boundTabId) {
    boundTab = await chrome.tabs.get(session.boundTabId).catch(() => null);
  }
  return {
    boundTabId: boundTab?.id || null,
    boundTabUrl: boundTab?.url || "",
    editorKind: boundTab ? resolveEditorKind(boundTab.url || "") : "",
    aiTabIds: session.aiTabIds || {},
  };
}

function resolveEditorKind(url) {
  const value = String(url || "");
  if (/^https:\/\/(m\.)?blog\.naver\.com\/|^https:\/\/blog\.editor\.naver\.com\//.test(value)) return "naver";
  if (/^https:\/\/cafe\.naver\.com\/.*(write|Write)/.test(value)) return "naver";
  if (/^https:\/\/editor\.naver\.com\//.test(value)) return "naver";
  if (/^https:\/\/[^/]+\.tistory\.com\/manage\/|^https:\/\/[^/]+\.tistory\.com\/admin\//.test(value)) return "tistory";
  if (/^https:\/\/(www|draft)\.blogger\.com\//.test(value)) return "blogger";
  if (/^https:\/\/www\.instagram\.com\//.test(value)) return "instagram";
  if (/^https:\/\/(www\.)?threads\.(com|net)\//.test(value)) return "threads";
  return "";
}

/* ----------------------------------------------------------------- router -- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch(async (error) => {
      await appendDebugLog("message.failed", {
        type: String(message?.type || ""),
        error: error?.message || String(error),
      }).catch(() => {});
      sendResponse({ ok: false, error: error?.message || String(error), errorCode: error?.code || "" });
    });
  return true;
});

async function handleMessage(message, sender) {
  const type = String(message?.type || "");
  await appendDebugLog("message.received", { type });

  switch (type) {
    case "NB_GET_CONTEXT":
      return { context: await panelContext() };

    case "NB_BIND_ACTIVE_TAB": {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const kind = resolveEditorKind(active?.url || "");
      if (!kind) {
        throw new Error("연결할 수 있는 글쓰기 탭이 아닙니다. 네이버 블로그·카페, 티스토리, Blogger, Instagram, Threads 탭에서 눌러 주세요.");
      }
      await updateSession({ boundTabId: active.id });
      // Only report a successful bind when the editor area really exists, so a
      // half-loaded write page does not look connected.
      const editor = await diagnoseEditor();
      return {
        context: await panelContext(),
        editorKind: kind,
        editorReady: editor.ok === true,
        editor,
      };
    }

    case "NB_OPEN_AI": {
      const provider = normalizeProvider(message.provider);
      const tab = await ensureAiTab(provider, { focus: true });
      return { provider, aiTabId: tab.id, context: await panelContext() };
    }

    case "NB_SUBMIT_AI": {
      await DDALKKAK_ACCESS.ensureAccess();
      const provider = normalizeProvider(message.provider);
      const payload = await runAiPrompt(provider, String(message.prompt || ""), message.options || {});
      return { provider, ...payload, context: await panelContext() };
    }

    case "NB_CANCEL_IMAGE_BATCH": {
      const provider = normalizeProvider(message.provider);
      const tab = await findAiTab(provider);
      if (!tab) return { cancelled: false };
      await chrome.tabs.sendMessage(tab.id, {
        type: "NB_CANCEL_IMAGE_BATCH",
        batchId: String(message.batchId || ""),
      }).catch(() => {});
      return { cancelled: true };
    }

    case "NB_CLOSE_AI": {
      const session = await readSession();
      for (const tabId of Object.values(session.aiTabIds || {})) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab?.windowId) await chrome.windows.remove(tab.windowId).catch(() => {});
      }
      await updateSession({ aiTabIds: {} });
      return { closed: true };
    }

    case "NB_INSERT_POST": {
      const session = await readSession();
      const tabId = Number(message.tabId) || session.boundTabId;
      if (!tabId) throw new Error("먼저 ① 현재 탭 연결하기를 눌러 글쓰기 탭을 연결하세요.");
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw new Error("연결된 탭을 찾지 못했습니다. 다시 연결해 주세요.");
      const payload = { ...(message.payload || {}) };
      const kind = payload.platform === "instagram" || payload.platform === "threads"
        ? payload.platform
        : resolveEditorKind(tab.url || "");
      if (!kind) throw new Error("지원하지 않는 글쓰기 탭입니다.");
      // A connected Instagram/Threads tab must be driven through its own filler
      // even when the panel did not send an explicit platform.
      if (["instagram", "threads"].includes(kind)) payload.platform = kind;

      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: pageInsertPost,
        args: [payload],
      });
      const pageResult = results?.[0]?.result || {};
      if (pageResult.ok === false) throw new Error(pageResult.error || "입력에 실패했습니다.");

      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
      await appendDebugLog("insert.completed", { kind, ...pageResult });
      return { insertion: { editorKind: kind, ...pageResult }, context: await panelContext() };
    }

    case "NB_COLLECT_NAVER_RESEARCH":
      return { research: await collectNaverResearch(String(message.keyword || ""), Number(message.maxResults) || 5) };

    case "NB_FETCH_IMAGE_AS_DATA_URL":
      return { dataUrl: await fetchImageAsDataUrl(String(message.url || "")) };

    case "NB_DIAGNOSE":
      return { diagnostics: await runDiagnostics() };

    case "NB_ACCESS_STATUS":
      return {
        access: await DDALKKAK_ACCESS.summarize(),
        endpoint: await DDALKKAK_ACCESS.getEndpoint(),
      };

    case "NB_ACCESS_SET_ENDPOINT": {
      await DDALKKAK_ACCESS.setEndpoint(String(message.endpoint || ""));
      return { access: await DDALKKAK_ACCESS.summarize() };
    }

    case "NB_ACCESS_VERIFY_LICENSE": {
      await DDALKKAK_ACCESS.verifyLicenseKey(message.licenseKey);
      return { access: await DDALKKAK_ACCESS.summarize() };
    }

    case "NB_ACCESS_CLEAR_LICENSE": {
      await DDALKKAK_ACCESS.clearLicense();
      return { access: await DDALKKAK_ACCESS.summarize() };
    }

    case "NB_ACCESS_OPEN_REWARD": {
      const reward = await DDALKKAK_ACCESS.openRewardPage(message.language);
      return { reward, access: await DDALKKAK_ACCESS.summarize() };
    }

    case "NB_ACCESS_CLAIM_REWARD": {
      await DDALKKAK_ACCESS.claimReward();
      return { access: await DDALKKAK_ACCESS.summarize() };
    }

    case "NB_ACCESS_VERIFY_MEMBERSHIP": {
      await DDALKKAK_ACCESS.verifyMembership();
      return { access: await DDALKKAK_ACCESS.summarize() };
    }

    // Long AI waits can outlive the service worker's 30s idle timer, which used
    // to close the message channel mid-request. The panel pings while waiting.
    case "NB_KEEPALIVE":
      return { alive: true };

    case "NB_ADD_DEBUG_LOG":
      await appendDebugLog(String(message?.entry?.event || "event"), message?.entry?.details || {});
      return { appended: true };

    case "NB_GET_DEBUG_LOG": {
      const entries = await readDebugLog();
      return { entries, formattedLog: formatDebugLog(entries) };
    }

    case "NB_CLEAR_DEBUG_LOG":
      await chrome.storage.local.set({ [DEBUG_LOG_KEY]: [] });
      return { cleared: true };

    default:
      throw new Error("알 수 없는 요청입니다.");
  }
}

function normalizeProvider(value) {
  const normalized = String(value || "gemini").trim().toLowerCase();
  return ["gemini", "chatgpt", "claude"].includes(normalized) ? normalized : "gemini";
}

/* -------------------------------------------------------------- AI window -- */

async function findAiTab(provider) {
  const session = await readSession();
  const tabId = session.aiTabIds?.[provider];
  if (!tabId) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    const next = { ...(session.aiTabIds || {}) };
    delete next[provider];
    await updateSession({ aiTabIds: next });
    return null;
  }
  return tab;
}

async function ensureAiTab(provider, { focus = false, newChat = false } = {}) {
  const existing = await findAiTab(provider);
  if (existing) {
    if (newChat) {
      await chrome.tabs.update(existing.id, { url: PROVIDER_URLS[provider] }).catch(() => {});
      await waitForTabComplete(existing.id, 45000);
    }
    if (focus) {
      await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
      await chrome.tabs.update(existing.id, { active: true }).catch(() => {});
    }
    return existing;
  }

  const current = await chrome.windows.getCurrent().catch(() => null);
  const window = await chrome.windows.create({
    url: PROVIDER_URLS[provider],
    type: "popup",
    width: 520,
    height: 860,
    left: current ? Math.max(0, (current.left || 0) + (current.width || 1200) - 540) : undefined,
    top: current ? (current.top || 0) + 40 : undefined,
    focused: focus,
  });
  const tab = window.tabs?.[0];
  if (!tab?.id) throw new Error(`${PROVIDER_TITLES[provider]} 창을 열지 못했습니다.`);
  const session = await readSession();
  await updateSession({ aiTabIds: { ...(session.aiTabIds || {}), [provider]: tab.id } });
  await waitForTabComplete(tab.id, 45000);
  return await chrome.tabs.get(tab.id);
}

function waitForTabComplete(tabId, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === "complete") finish();
    };
    const timer = setTimeout(finish, timeout);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === "complete") finish();
    }).catch(finish);
  });
}

async function pingAiTab(tabId, provider) {
  const type = provider === "chatgpt" ? "NB_CHATGPT_PING" : provider === "claude" ? "NB_CLAUDE_PING" : "NB_GEMINI_PING";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const reply = await chrome.tabs.sendMessage(tabId, { type }).catch(() => null);
    if (reply?.ok) return true;
    if (attempt === 4) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["ai-automation.js", `${provider === "chatgpt" ? "chatgpt" : provider}-content.js`],
      }).catch(() => {});
    }
    await sleep(750);
  }
  return false;
}

async function runAiPrompt(provider, prompt, options = {}) {
  if (!prompt.trim()) throw new Error("프롬프트가 비어 있습니다.");
  // Fresh conversations are started inside the page (config.newChatSelectors).
  // Reloading the whole tab here used to drop the editor and slow every image.
  const tab = await ensureAiTab(provider);
  const ready = await pingAiTab(tab.id, provider);
  if (!ready) {
    throw new Error(`${PROVIDER_TITLES[provider]} 화면에 연결하지 못했습니다. 로그인 상태와 인터넷 연결을 확인한 뒤 다시 시도하세요.`);
  }
  await appendDebugLog("ai.submit", { provider, promptLength: prompt.length, imageMode: !!options.imageMode });

  const messageType = provider === "chatgpt" ? "NB_CHATGPT_SUBMIT"
    : provider === "claude" ? "NB_CLAUDE_SUBMIT" : "NB_GEMINI_SUBMIT";
  const reply = await chrome.tabs.sendMessage(tab.id, {
    type: messageType,
    prompt,
    options: { ...options, provider },
  }).catch((error) => ({ ok: false, error: error?.message || String(error) }));

  if (!reply?.ok) throw new Error(reply?.error || `${PROVIDER_TITLES[provider]} 요청이 실패했습니다.`);
  await appendDebugLog("ai.response", {
    provider,
    responseLength: String(reply.response || "").length,
    imageCount: Array.isArray(reply.images) ? reply.images.length : 0,
  });
  return { response: String(reply.response || ""), images: Array.isArray(reply.images) ? reply.images : [], aiTabId: tab.id };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* --------------------------------------------------------------- research -- */

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function collectNaverResearch(keyword, maxResults = 5) {
  const query = String(keyword || "").trim();
  if (!query) throw new Error("검색 키워드를 입력하세요.");
  const limit = Math.min(8, Math.max(1, maxResults));

  const listUrl = `https://section.blog.naver.com/Search/Post.naver?keyword=${encodeURIComponent(query)}`;
  const response = await fetch(listUrl, { credentials: "include" });
  if (!response.ok) throw new Error(`네이버 블로그 검색에 실패했습니다 (${response.status}).`);
  const html = await response.text();

  const references = [];
  const anchorPattern = /<a[^>]+href="(https:\/\/blog\.naver\.com\/[^"?]+)"[^>]*>([\s\S]{0,400}?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html)) && references.length < limit * 2) {
    const url = match[1];
    if (/blog\.naver\.com\/(PostView|MyBlog|Bridge)\.naver/i.test(url)) continue;
    const title = stripHtml(match[2]).slice(0, 120);
    if (!title || references.some((entry) => entry.url === url)) continue;
    references.push({ url, title, snippet: "", content: "" });
  }

  if (!references.length) {
    throw new Error("검색 결과를 읽지 못했습니다. 키워드를 바꾸거나 직접 입력 모드를 사용하세요.");
  }

  for (const entry of references.slice(0, limit)) {
    try {
      const url = entry.url.replace("blog.naver.com/", "m.blog.naver.com/");
      const page = await fetch(url, { credentials: "include" });
      if (!page.ok) continue;
      const text = stripHtml(await page.text());
      entry.content = text.slice(0, 6000);
      entry.snippet = text.slice(0, 220);
    } catch { /* a single failed reference must not stop the draft */ }
    await sleep(120);
  }

  return {
    keyword: query,
    requestedReferenceCount: limit,
    references: references.slice(0, limit),
    collectedAt: Date.now(),
  };
}

async function fetchImageAsDataUrl(url) {
  if (!url) throw new Error("이미지 주소가 없습니다.");
  if (url.startsWith("data:")) return url;
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`이미지를 가져오지 못했습니다 (${response.status}).`);
  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  }
  return `data:${blob.type || "image/png"};base64,${btoa(binary)}`;
}

/* ------------------------------------------------------------ diagnostics -- */

const PROVIDER_TAB_MATCH = {
  gemini: /^https:\/\/gemini\.google\.com\//,
  chatgpt: /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//,
  claude: /^https:\/\/claude\.ai\//,
};

const PROVIDER_CONTENT_SCRIPT = {
  gemini: "gemini-content.js",
  chatgpt: "chatgpt-content.js",
  claude: "claude-content.js",
};

async function findProviderTab(provider) {
  const session = await readSession();
  const tabs = await chrome.tabs.query({});
  const storedId = session.aiTabIds?.[provider];
  if (storedId) {
    const stored = tabs.find((tab) => tab.id === storedId);
    if (stored) return stored;
  }
  return tabs.find((tab) => PROVIDER_TAB_MATCH[provider]?.test(tab.url || "")) || null;
}

async function diagnoseProvider(provider) {
  const tab = await findProviderTab(provider);
  if (!tab) return { open: false, note: `${PROVIDER_TITLES[provider]} 탭이 열려 있지 않습니다.` };

  const base = { open: true, tabId: tab.id, url: tab.url || "" };
  let reply = await chrome.tabs.sendMessage(tab.id, { type: "NB_AI_DIAGNOSE" }).catch(() => null);
  if (!reply) {
    // A very old tab (or one opened before install) may not carry the content
    // script yet: inject, then retry once.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["ai-automation.js", PROVIDER_CONTENT_SCRIPT[provider]],
    }).catch(() => {});
    await sleep(500);
    reply = await chrome.tabs.sendMessage(tab.id, { type: "NB_AI_DIAGNOSE" }).catch(() => null);
  }
  if (!reply) {
    return { ...base, reachable: false, error: "탭이 응답하지 않습니다. AI 페이지를 새로고침한 뒤 다시 시도하세요." };
  }
  if (reply.ok === false) return { ...base, reachable: true, error: reply.error || "진단하지 못했습니다." };
  return { ...base, reachable: true, ...reply };
}

async function diagnoseEditor() {
  const session = await readSession();
  if (!session.boundTabId) {
    return { open: false, note: "글쓰기 탭이 연결되지 않았습니다. ‘① 현재 탭 연결하기’를 먼저 누르세요." };
  }
  const tab = await chrome.tabs.get(session.boundTabId).catch(() => null);
  if (!tab) return { open: false, note: "연결된 탭을 찾지 못했습니다. 다시 연결하세요." };

  const injected = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pageDiagnoseEditor,
  }).catch((error) => [{ result: { error: error?.message || String(error) } }]);

  const result = injected?.[0]?.result;
  if (!result) return { open: true, tabId: tab.id, url: tab.url || "", error: "페이지 진단을 실행하지 못했습니다." };
  return { open: true, tabId: tab.id, url: tab.url || "", ...result };
}

async function runDiagnostics() {
  const [gemini, chatgpt, claude, editor] = await Promise.all([
    diagnoseProvider("gemini"),
    diagnoseProvider("chatgpt"),
    diagnoseProvider("claude"),
    diagnoseEditor(),
  ]);
  const diagnostics = {
    generatedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    ai: { gemini, chatgpt, claude },
    editor,
  };
  await appendDebugLog("diagnose.completed", {
    gemini: Boolean(gemini.ok),
    chatgpt: Boolean(chatgpt.ok),
    claude: Boolean(claude.ok),
    editorKind: editor.kind || "",
    editorOk: Boolean(editor.ok),
  });
  return diagnostics;
}

/* -------------------------------------------------------------- debug log -- */

async function readDebugLog() {
  const stored = await chrome.storage.local.get(DEBUG_LOG_KEY);
  return Array.isArray(stored[DEBUG_LOG_KEY]) ? stored[DEBUG_LOG_KEY] : [];
}

async function appendDebugLog(event, details = {}) {
  if (event === "message.received") return;
  const entries = await readDebugLog();
  entries.push({ at: new Date().toISOString(), event, details });
  await chrome.storage.local.set({ [DEBUG_LOG_KEY]: entries.slice(-DEBUG_LOG_LIMIT) });
}

function formatDebugLog(entries) {
  return entries.map((entry) => {
    const time = String(entry.at || "").replace("T", " ").slice(0, 19);
    const details = entry.details && Object.keys(entry.details).length
      ? ` ${JSON.stringify(entry.details)}`
      : "";
    return `[${time}] ${entry.event}${details}`;
  }).join("\n");
}

/* ------------------------------------------------------------ page driver -- */

// Serialized into the target tab by chrome.scripting.executeScript, so this
// function must not reference anything outside its own body.
async function pageInsertPost(payload) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const query = (selectors, root = document) => {
    for (const selector of selectors) {
      let node = null;
      try { node = root.querySelector(selector); } catch { continue; }
      if (node) return node;
    }
    return null;
  };
  const queryAll = (selectors, root = document) => {
    const nodes = [];
    for (const selector of selectors) {
      try { nodes.push(...Array.from(root.querySelectorAll(selector))); } catch { /* ignore */ }
    }
    return nodes;
  };
  const visibleNodes = (selectors) => queryAll(selectors).filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const setInputValue = (element, value) => {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value); else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const pasteHtml = (element, html, text) => {
    const transfer = new DataTransfer();
    transfer.setData("text/html", html);
    transfer.setData("text/plain", text);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const pasteFile = (element, file) => {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
    element.dispatchEvent(event);
  };
  const dataUrlToFile = async (dataUrl, name) => {
    const blob = await (await fetch(dataUrl)).blob();
    return new File([blob], name || `image-${Date.now()}.png`, { type: blob.type || "image/png" });
  };
  const waitFor = async (getter, timeout = 12000, interval = 300) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = getter();
      if (value) return value;
      await sleep(interval);
    }
    return null;
  };
  const textLength = (element) => String(element?.innerText || element?.textContent || "").replace(/\s/g, "").length;
  const placeCaretIn = (element) => {
    element?.focus?.();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  // Photos are placed where the article put its [data-photo-slot] markers so the
  // order in the preview matches the post. Leftover markers are removed.
  const insertImagesAtSlots = async (body, imageList) => {
    let added = 0;
    for (let index = 0; index < imageList.length; index += 1) {
      const marker = body?.querySelector?.(`[data-photo-slot="${index}"]`) || null;
      const target = marker || body;
      try {
        const file = await dataUrlToFile(imageList[index].dataUrl, imageList[index].fileName);
        placeCaretIn(target);
        pasteFile(target, file);
        if (marker) marker.remove();
        added += 1;
      } catch { /* keep going: one photo must not abort the insert */ }
      await sleep(1800);
    }
    for (const leftover of Array.from(body?.querySelectorAll?.("[data-photo-slot]") || [])) leftover.remove();
    return added;
  };

  const title = String(payload.title || "").trim();
  const html = String(payload.html || "").trim();
  const text = String(payload.text || "").trim();
  const tags = Array.isArray(payload.tags) ? payload.tags.filter(Boolean) : [];
  const images = Array.isArray(payload.images) ? payload.images.filter((entry) => entry?.dataUrl) : [];

  try {
    if (payload.platform === "instagram") return await fillInstagram();
    if (payload.platform === "threads") return await fillThreads();

    const host = location.hostname;
    if (/tistory\.com$/.test(host)) return await fillTistory();
    if (/blogger\.com$/.test(host)) return await fillBlogger();
    return await fillNaver();

    // SmartEditor ONE keeps an off-screen contenteditable for paste capture. It
    // must never be mistaken for the article body.
    function isHiddenTypingBuffer(element) {
      if (!element?.isContentEditable) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return element.getAttribute("aria-hidden") === "true"
        && (style.position === "fixed" || style.position === "absolute")
        && (rect.left < -200 || String(style.left || "").startsWith("-"));
    }

    // SE ONE puts contenteditable on .se-component-content / .se-text-paragraph
    // themselves; the wrapper chain differs per editor build, so try both.
    // These MUST stay function declarations: pageInsertPost returns before it is
    // reached, so a `const` here would still be in its temporal dead zone and
    // fail with "Cannot access … before initialization".
    function naverBodySelectors() {
      return [
        ".se-main-container .se-text-paragraph[contenteditable='true']",
        ".se-component-content[contenteditable='true']",
        ".se-main-container [contenteditable='true']",
        ".se-wrapper .se-text-paragraph[contenteditable='true']",
        ".se-wrapper [contenteditable='true']",
        "[contenteditable='true'][role='textbox']",
        ".se-text-paragraph[contenteditable='true']",
      ];
    }

    function pickNaverBody() {
      const area = (node) => {
        const box = node.getBoundingClientRect();
        return box.width * box.height;
      };
      for (const selector of naverBodySelectors()) {
        let nodes = [];
        try { nodes = Array.from(document.querySelectorAll(selector)); } catch { continue; }
        const usable = nodes.filter((node) => !isHiddenTypingBuffer(node)
          && !node.closest(".se-documentTitle, .se-title-text, .se-toolbar, .se-help-panel"));
        if (usable.length) {
          // Several paragraphs can be editable: the body is the largest area.
          return usable.sort((left, right) => area(right) - area(left))[0];
        }
      }
      // Last resort: any visible editable area that is not the title or toolbar.
      // Editor builds rename their wrapper classes, so do not require one here.
      return Array.from(document.querySelectorAll("[contenteditable='true']"))
        .filter((node) => !isHiddenTypingBuffer(node)
          && !node.closest(".se-documentTitle, .se-title-text, .se-toolbar, .se-help-panel")
          && area(node) > 2000)
        .sort((left, right) => area(right) - area(left))[0] || null;
    }

    async function fillNaver() {
      const titleNode = await waitFor(() => query([
        ".se-component.se-documentTitle[data-a11y-title='제목'] .se-title-text",
        ".se-component.se-documentTitle[data-a11y-title='제목'] .se-section-documentTitle",
        ".se-component.se-documentTitle .se-title-text",
        ".se-component.se-documentTitle",
        "input.se-title-text",
        ".se-title-text .se-text-paragraph",
        ".se-documentTitle input",
        ".se-title-text",
        'textarea[placeholder*="제목"]',
        'input[placeholder*="제목"]',
      ]), 15000);

      if (titleNode) {
        if (titleNode.isContentEditable) {
          titleNode.focus();
          const titleRange = document.createRange();
          titleRange.selectNodeContents(titleNode);
          const titleSelection = window.getSelection();
          titleSelection.removeAllRanges();
          titleSelection.addRange(titleRange);
          document.execCommand("insertText", false, title);
          if (!String(titleNode.innerText || titleNode.textContent || "").includes(title.slice(0, 8))) {
            titleNode.textContent = title;
            titleNode.dispatchEvent(new Event("input", { bubbles: true }));
          }
        } else {
          titleNode.focus();
          setInputValue(titleNode, title);
        }
        await sleep(400);
      }

      const body = await waitFor(pickNaverBody, 25000);
      if (!body) {
        const editableCount = document.querySelectorAll("[contenteditable='true']").length;
        const inFrame = Boolean(document.querySelector("#mainFrame, iframe#editor_frame"));
        return {
          ok: false,
          error: "네이버 본문 편집 영역을 찾지 못했습니다(편집 영역 " + editableCount + "개"
            + (inFrame ? " · iframe 감지" : "") + "). 글쓰기 화면이 완전히 열린 뒤 다시 시도하고, 계속 실패하면 🩺 DOM 진단을 실행해 주세요.",
        };
      }

      body.focus();
      body.click?.();
      placeCaretIn(body);
      await sleep(250);

      const before = textLength(body);
      const grew = () => textLength(body) > before + 20;

      pasteHtml(body, html, text);
      let inserted = await waitFor(grew, 12000);
      let degraded = false;

      // A partially accepted paste must never be repeated: that duplicates text.
      if (!inserted && textLength(body) !== before) inserted = true;
      if (!inserted) {
        document.execCommand("insertHTML", false, html);
        inserted = await waitFor(grew, 8000);
      }
      if (!inserted) {
        document.execCommand("insertText", false, text);
        inserted = await waitFor(grew, 8000);
        degraded = Boolean(inserted);
      }
      if (!inserted) {
        return {
          ok: false,
          error: "본문 영역은 찾았지만 글자를 입력하지 못했습니다. 에디터를 한 번 클릭한 뒤 다시 시도해 주세요.",
        };
      }

      const addedImages = await insertImagesAtSlots(body, images);

      for (const tag of tags.slice(0, 10)) {
        const tagInput = query(["#tag-input", ".se-tag-input input", "input[placeholder*='태그']"]);
        if (!tagInput) break;
        tagInput.focus();
        setInputValue(tagInput, tag);
        tagInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
        tagInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", keyCode: 13, bubbles: true }));
        await sleep(350);
      }

      return {
        ok: true,
        editorKind: "naver",
        insertedText: Boolean(inserted),
        degraded,
        titleInserted: Boolean(titleNode),
        insertedImages: addedImages,
        imageTotal: images.length,
        tags: tags.length,
      };
    }

    async function fillTistory() {
      const frame = query(["#editor-tistory", "iframe.tox-edit-area__iframe", "iframe[id*='editor']"]);
      const doc = frame?.contentDocument || document;
      const titleInput = query(["#post-title-inp", "input[name='title']", ".tit-input"], doc);
      if (titleInput) setInputValue(titleInput, title);
      const body = await waitFor(() => query([
        ".ProseMirror", "[contenteditable='true']", "body#tinymce", "body",
      ], doc), 15000);
      if (!body) return { ok: false, error: "티스토리 본문 영역을 찾지 못했습니다. 에디터가 열린 상태인지 확인하세요." };
      body.focus();
      const before = textLength(body);
      pasteHtml(body, html, text);
      const inserted = await waitFor(() => textLength(body) > before + 20, 10000);
      if (!inserted) {
        document.execCommand("insertHTML", false, html);
      }
      const addedImages = await insertImagesAtSlots(body, images);
      return { ok: true, editorKind: "tistory", insertedText: Boolean(inserted), insertedImages: addedImages, imageTotal: images.length };
    }

    async function fillBlogger() {
      const titleInput = await waitFor(() => query(["input[name='title']", "#title-field input", ".title input"]), 15000);
      if (titleInput) setInputValue(titleInput, title);
      const body = await waitFor(() => query([
        ".editable[contenteditable='true']", "div[contenteditable='true'][role='textbox']", "iframe.editable",
      ]), 20000);
      if (!body) return { ok: false, error: "Blogger 본문 영역을 찾지 못했습니다. 새 글 작성 화면에서 다시 시도하세요." };
      const doc = body.contentDocument || document;
      const target = body.contentDocument ? doc.body : body;
      target.focus();
      const before = textLength(target);
      pasteHtml(target, html, text);
      if (textLength(target) <= before) document.execCommand("insertHTML", false, html);
      const inserted = await waitFor(() => textLength(target) > before + 20, 8000);
      const addedImages = await insertImagesAtSlots(target, images);
      return { ok: true, editorKind: "blogger", insertedText: Boolean(inserted), insertedImages: addedImages, imageTotal: images.length };
    }

    async function fillInstagram() {
      const fileInput = query(["input[type='file'][accept*='image']", "input[type='file']"]);
      let attached = 0;
      if (fileInput && images.length) {
        const transfer = new DataTransfer();
        for (const image of images.slice(0, 10)) {
          const file = await dataUrlToFile(image.dataUrl, image.fileName);
          transfer.items.add(file);
        }
        fileInput.files = transfer.files;
        fileInput.dispatchEvent(new Event("input", { bubbles: true }));
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        attached = transfer.items.length;
      }

      const caption = await waitFor(() => query([
        "textarea[aria-label*='문구']",
        "textarea[aria-label*='caption' i]",
        "div[contenteditable='true'][aria-label*='문구']",
        "div[contenteditable='true'][aria-label*='caption' i]",
        "textarea[placeholder*='문구']",
      ]), attached ? 30000 : 6000);

      if (!caption) {
        return {
          ok: false,
          error: attached
            ? "이미지는 선택했지만 캡션 입력란을 찾지 못했습니다. Instagram에서 '다음'을 눌러 캡션 단계까지 진행한 뒤 다시 시도하세요."
            : "Instagram 새 게시물 화면을 찾지 못했습니다. '만들기'로 새 게시물을 연 뒤 다시 시도하세요.",
        };
      }
      caption.focus();
      if (caption.isContentEditable) {
        caption.textContent = text;
        caption.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        setInputValue(caption, text);
      }
      return { ok: true, editorKind: "instagram", insertedText: true, insertedImages: attached, imageTotal: images.length, shared: false };
    }

    async function fillThreads() {
      const composer = query([
        "div[contenteditable='true'][role='textbox']",
        "div[contenteditable='true'][aria-label*='텍스트']",
        "div[contenteditable='true'][aria-label*='text' i]",
      ]);
      if (!composer) {
        return { ok: false, error: "Threads 작성창을 찾지 못했습니다. '만들기'를 눌러 글쓰기 창을 연 뒤 다시 시도하세요." };
      }
      const posts = Array.isArray(payload.posts) && payload.posts.length ? payload.posts : [text];
      let written = 0;
      for (let index = 0; index < posts.length; index += 1) {
        const target = index === 0 ? composer : query(["div[contenteditable='true'][role='textbox']"]);
        if (!target) break;
        target.focus();
        target.textContent = String(posts[index] || "");
        target.dispatchEvent(new Event("input", { bubbles: true }));
        written += 1;
        if (index < posts.length - 1) {
          const addButton = queryAll(["div[role='button']", "button"]).find((node) =>
            /스레드에 추가|Add to thread|さらに追加/i.test(node.textContent || node.getAttribute("aria-label") || ""));
          if (!addButton) break;
          addButton.click();
          await sleep(1200);
        }
      }

      let attached = 0;
      const fileInput = query(["input[type='file'][accept*='image']", "input[type='file']"]);
      if (fileInput && images.length) {
        const transfer = new DataTransfer();
        for (const image of images.slice(0, 10)) {
          transfer.items.add(await dataUrlToFile(image.dataUrl, image.fileName));
        }
        fileInput.files = transfer.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        attached = transfer.items.length;
      }
      return { ok: true, editorKind: "threads", insertedText: written > 0, postsWritten: written, insertedImages: attached, imageTotal: images.length, shared: false };
    }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

// Also serialized into the connected editor tab. Reports every candidate
// selector so a broken one shows up in the panel instead of a silent no-op.
function pageDiagnoseEditor() {
  const describe = (element) => {
    if (!element) return "";
    const tag = String(element.tagName || "").toLowerCase();
    const id = element.id ? `#${element.id}` : "";
    const className = typeof element.className === "string" && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}`
      : "";
    const label = element.getAttribute?.("aria-label") || "";
    return `${tag}${id}${className}${label ? `[${label}]` : ""}`.slice(0, 140);
  };
  const isVisible = (node) => {
    try {
      const rect = node.getBoundingClientRect();
      if (!rect.width && !rect.height) return false;
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden";
    } catch { return false; }
  };
  const probe = (selectors, root) => (selectors || []).map((selector) => {
    const entry = { selector, matched: 0, visible: 0, found: false, sample: "" };
    let nodes = [];
    try { nodes = Array.from((root || document).querySelectorAll(selector)); }
    catch (error) { entry.error = error?.message || String(error); return entry; }
    entry.matched = nodes.length;
    const visibleNodes = nodes.filter(isVisible);
    entry.visible = visibleNodes.length;
    const pick = nodes[0] || visibleNodes[0] || null;
    if (pick) { entry.found = true; entry.sample = describe(pick); }
    return entry;
  });
  const summarize = (entries) => {
    const firstFound = entries.find((entry) => entry.found);
    return {
      found: Boolean(firstFound),
      visible: entries.some((entry) => entry.visible > 0),
      selector: firstFound?.selector || "",
      matched: entries.reduce((total, entry) => total + entry.matched, 0),
    };
  };

  const host = location.hostname;
  const kind = /tistory\.com$/.test(host) ? "tistory"
    : /blogger\.com$/.test(host) ? "blogger"
      : /instagram\.com$/.test(host) ? "instagram"
        : /threads\.(com|net)$/.test(host) ? "threads"
          : "naver";

  const SELECTORS = {
    naver: {
      title_area: [
        ".se-component.se-documentTitle[data-a11y-title='제목'] .se-title-text",
        ".se-component.se-documentTitle .se-title-text",
        ".se-component.se-documentTitle",
        "input.se-title-text",
        ".se-title-text .se-text-paragraph",
        ".se-title-text",
        'textarea[placeholder*="제목"]',
        'input[placeholder*="제목"]',
      ],
      body_area: [
        ".se-main-container .se-text-paragraph[contenteditable='true']",
        ".se-component-content[contenteditable='true']",
        ".se-main-container [contenteditable='true']",
        ".se-wrapper .se-text-paragraph[contenteditable='true']",
        ".se-wrapper [contenteditable='true']",
        "[contenteditable='true'][role='textbox']",
      ],
      image_area: ["input[type='file'][accept*='image']", ".se-component.se-image img", ".se-image-resource", "img[src*='postfiles.pstatic.net']"],
      tag_area: ["#tag-input", ".se-tag-input input", "input[placeholder*='태그']"],
    },
    tistory: {
      title_area: ["#post-title-inp", "input[name='title']", ".tit-input"],
      body_area: [".ProseMirror", "#editor-tistory", "[contenteditable='true']"],
      image_area: ["input[type='file'][accept*='image']", "input[type='file']", ".ProseMirror img"],
      tag_area: ["#tag-input", "input[name='tag']"],
    },
    blogger: {
      title_area: ["input[name='title']", "#title-field input", ".title input"],
      body_area: [".editable[contenteditable='true']", "div[contenteditable='true'][role='textbox']", "iframe.editable"],
      image_area: ["input[type='file'][accept*='image']", "input[type='file']", ".editable img"],
      tag_area: ["input[name='labels']", ".labels input"],
    },
    instagram: {
      title_area: ["textarea[aria-label*='문구']", "textarea[aria-label*='caption' i]", "div[contenteditable='true'][aria-label*='문구']", "div[contenteditable='true'][aria-label*='caption' i]", "textarea[placeholder*='문구']"],
      body_area: ["div[role='dialog']", "div[role='dialog'] form"],
      image_area: ["input[type='file'][accept*='image']", "input[type='file']"],
      tag_area: [],
    },
    threads: {
      title_area: ["div[contenteditable='true'][role='textbox']", "div[contenteditable='true'][aria-label*='텍스트']", "div[contenteditable='true'][aria-label*='text' i]"],
      body_area: ["div[role='dialog']", "[role='dialog']"],
      image_area: ["input[type='file'][accept*='image']", "input[type='file']"],
      tag_area: [],
    },
  };

  const config = SELECTORS[kind];
  // Tistory and Blogger may host the body inside a same-origin iframe.
  let frameDoc = null;
  if (kind === "tistory" || kind === "blogger") {
    try {
      const frame = document.querySelector("#editor-tistory, iframe[id*='editor'], iframe.tox-edit-area__iframe, iframe.editable");
      frameDoc = frame?.contentDocument || null;
    } catch { frameDoc = null; }
  }
  const roots = frameDoc ? [document, frameDoc] : [document];

  const groups = {};
  for (const key of Object.keys(config)) {
    const merged = new Map();
    for (const root of roots) {
      for (const entry of probe(config[key], root)) {
        const previous = merged.get(entry.selector);
        if (!previous) { merged.set(entry.selector, { ...entry }); continue; }
        previous.matched += entry.matched;
        previous.visible += entry.visible;
        previous.found = previous.found || entry.found;
        if (!previous.sample && entry.sample) previous.sample = entry.sample;
      }
    }
    groups[key] = Array.from(merged.values());
  }

  // Editor builds rename their wrapper classes, so also report every editable
  // area: a false "not ready" blocks the whole insert flow even though the page
  // is fine.
  let editableCandidates = [];
  if (kind === "naver") {
    editableCandidates = Array.from(document.querySelectorAll("[contenteditable='true']"))
      .filter(isVisible)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          sample: describe(node),
          area: Math.round(rect.width * rect.height),
          inTitle: Boolean(node.closest(".se-documentTitle, .se-title-text, .se-toolbar")),
          placeholder: String(node.getAttribute("data-placeholder") || node.getAttribute("aria-label") || "").slice(0, 40),
        };
      })
      .slice(0, 12);
  }
  const broadBody = editableCandidates.some((entry) => !entry.inTitle && entry.area > 2000);

  const status = {
    title_area: summarize(groups.title_area),
    body_area: { ...summarize(groups.body_area), broad: broadBody },
    image_area: summarize(groups.image_area),
    tag_area: summarize(groups.tag_area),
  };

  const bodyRoot = frameDoc || document;
  const ok = kind === "instagram" || kind === "threads"
    ? status.title_area.found
    : status.title_area.found && (status.body_area.found || broadBody);

  return {
    kind,
    url: location.href,
    pageTitle: document.title,
    inIframe: Boolean(frameDoc),
    ok,
    status,
    counts: {
      paragraphs: bodyRoot.querySelectorAll("p, .se-text-paragraph, li").length,
      images: bodyRoot.querySelectorAll("img").length,
    },
    editableCandidates,
    selectors: groups,
  };
}
