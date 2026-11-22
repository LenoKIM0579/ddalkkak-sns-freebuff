// Shared automation helpers used by the Gemini / ChatGPT / Claude content scripts.
// The extension has no paid API key: it drives the AI web UI the user is already
// signed in to, then reads the answer back out of the page.
(() => {
  if (globalThis.DDALKKAK_AI) return;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(getter, { timeout = 20000, interval = 250 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const value = await getter();
        if (value) return value;
      } catch { /* keep polling */ }
      await sleep(interval);
    }
    return null;
  }

  function visible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (!rect.width && !rect.height) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0;
  }

  function findFirst(selectors, { requireVisible = true } = {}) {
    for (const selector of selectors) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(selector)); } catch { continue; }
      const match = nodes.find((node) => !requireVisible || visible(node));
      if (match) return match;
    }
    return null;
  }

  function findByText(selectors, texts) {
    const wanted = texts.map((text) => String(text).toLowerCase());
    for (const selector of selectors) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(selector)); } catch { continue; }
      const match = nodes.find((node) => {
        if (!visible(node)) return false;
        const label = `${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""} ${node.textContent || ""}`.toLowerCase();
        return wanted.some((text) => label.includes(text));
      });
      if (match) return match;
    }
    return null;
  }

  function dispatchInputEvents(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  }

  function normalizeText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function placeCaretAtEnd(element) {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function fillPromptEditor(editor, text) {
    editor.focus();
    editor.click?.();
    await sleep(120);

    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      setNativeValue(editor, text);
      dispatchInputEvents(editor);
      await sleep(80);
      return editor.value.includes(text.slice(0, 24));
    }

    placeCaretAtEnd(editor);
    // Select everything inside the editor only, then replace it in one edit so
    // React / Angular / Quill all see a normal text insertion.
    const range = document.createRange();
    range.selectNodeContents(editor);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    await sleep(60);

    try { document.execCommand("insertText", false, text); } catch { /* fallback below */ }
    await sleep(150);

    if (!normalizeText(editor.textContent).includes(normalizeText(text).slice(0, 24))) {
      editor.textContent = text;
      dispatchInputEvents(editor);
      await sleep(120);
    }
    return normalizeText(editor.textContent).includes(normalizeText(text).slice(0, 24));
  }

  async function clickSend(sendSelectors, editor) {
    const button = await waitFor(() => findFirst(sendSelectors, { requireVisible: true }), {
      timeout: 6000,
      interval: 200,
    });
    if (button && !button.disabled && !button.getAttribute("aria-disabled")) {
      button.click();
      return true;
    }
    // Fallback: Enter inside the editor (most of these apps submit on Enter).
    const target = editor || document.activeElement;
    if (!target) return false;
    for (const type of ["keydown", "keypress", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true,
      }));
      await sleep(60);
    }
    return true;
  }

  function responseNodes(selectors) {
    const nodes = [];
    for (const selector of selectors) {
      let found = [];
      try { found = Array.from(document.querySelectorAll(selector)); } catch { continue; }
      for (const node of found) if (!nodes.includes(node)) nodes.push(node);
    }
    return nodes;
  }

  function latestResponseText(selectors) {
    const nodes = responseNodes(selectors);
    const last = nodes[nodes.length - 1];
    return last ? String(last.innerText || last.textContent || "").trim() : "";
  }

  function responseSignature(selectors) {
    const text = latestResponseText(selectors);
    return `${responseNodes(selectors).length}:${text.length}:${text.slice(-64)}`;
  }

  function isGenerating() {
    return Boolean(findFirst([
      'button[aria-label*="Stop"]', 'button[aria-label*="중지"]', 'button[data-testid="stop-button"]',
      'button[aria-label*="Cancel"]', 'button[aria-label*="취소"]',
    ], { requireVisible: true }));
  }

  async function waitForAnswer(selectors, previous, { timeout = 240000, idle = 3000 } = {}) {
    const deadline = Date.now() + timeout;
    let best = "";
    let lastChange = Date.now();
    let changed = false;
    while (Date.now() < deadline) {
      await sleep(500);
      const text = latestResponseText(selectors);
      if (text && text !== best) {
        best = text;
        lastChange = Date.now();
      }
      const signature = responseSignature(selectors);
      if (signature !== previous) changed = true;
      if (best && !isGenerating() && Date.now() - lastChange > idle && changed) {
        return best;
      }
    }
    return best;
  }

  function describeElement(element) {
    if (!element) return "";
    const tag = String(element.tagName || "").toLowerCase();
    const id = element.id ? `#${element.id}` : "";
    const className = typeof element.className === "string" && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}`
      : "";
    const label = element.getAttribute?.("aria-label") || element.getAttribute?.("data-testid") || "";
    return `${tag}${id}${className}${label ? `[${label}]` : ""}`.slice(0, 140);
  }

  // Diagnostics: report every candidate selector instead of only the first hit,
  // so a broken selector is visible in the panel rather than a silent failure.
  function probeSelectors(selectors, { root = document, requireVisible = false } = {}) {
    return (selectors || []).map((selector) => {
      const entry = { selector, matched: 0, visible: 0, found: false, sample: "" };
      let nodes = [];
      try {
        nodes = Array.from(root.querySelectorAll(selector));
      } catch (error) {
        entry.error = error?.message || String(error);
        return entry;
      }
      entry.matched = nodes.length;
      const visibleNodes = nodes.filter((node) => {
        try { return visible(node); } catch { return false; }
      });
      entry.visible = visibleNodes.length;
      const pick = (requireVisible ? visibleNodes[0] : nodes[0]) || visibleNodes[0] || null;
      if (pick) {
        entry.found = true;
        entry.sample = describeElement(pick);
      }
      return entry;
    });
  }

  function summarizeProbes(entries) {
    const firstFound = entries.find((entry) => entry.found);
    return {
      found: Boolean(firstFound),
      visible: entries.some((entry) => entry.visible > 0),
      selector: firstFound?.selector || "",
      matched: entries.reduce((total, entry) => total + entry.matched, 0),
    };
  }

  function diagnose(config) {
    const groups = {
      promptEditor: probeSelectors(config.promptSelectors, { requireVisible: false }),
      sendButton: probeSelectors(config.sendSelectors, { requireVisible: true }),
      responseArea: probeSelectors(config.responseSelectors, { requireVisible: false }),
      attachments: probeSelectors(config.attachSelectors || [], { requireVisible: false }),
    };
    const promptEditor = summarizeProbes(groups.promptEditor);
    const sendButton = summarizeProbes(groups.sendButton);
    const responseArea = summarizeProbes(groups.responseArea);
    return {
      url: location.href,
      pageTitle: document.title,
      readyState: document.readyState,
      promptEditor,
      sendButton,
      responseArea,
      ok: promptEditor.found && sendButton.found && responseArea.found,
      selectors: groups,
    };
  }

  function dataUrlFromBlob(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => resolve("");
      reader.readAsDataURL(blob);
    });
  }

  async function imageToDataUrl(image) {
    const source = image.currentSrc || image.src || "";
    if (!source) return "";
    if (source.startsWith("data:")) return source;
    try {
      const response = await fetch(source, { credentials: "include" });
      if (response.ok) {
        const blob = await response.blob();
        if (blob.size > 0) return await dataUrlFromBlob(blob);
      }
    } catch { /* fall through to canvas */ }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      if (!canvas.width || !canvas.height) return "";
      canvas.getContext("2d").drawImage(image, 0, 0);
      return canvas.toDataURL("image/png");
    } catch {
      return "";
    }
  }

  async function collectImages(selectors, { sinceCount = 0, max = 10 } = {}) {
    const roots = responseNodes(selectors);
    const scoped = roots.length ? roots.slice(Math.max(0, roots.length - 2)) : [document.body];
    const images = [];
    for (const root of scoped) {
      for (const image of Array.from(root.querySelectorAll("img"))) {
        const rect = image.getBoundingClientRect();
        if (!rect.width || rect.width < 80 || rect.height < 80) continue;
        if (!images.includes(image)) images.push(image);
      }
    }
    const picked = images.slice(sinceCount).slice(-max);
    const result = [];
    for (const image of picked) {
      await waitFor(() => image.complete && image.naturalWidth > 0, { timeout: 15000, interval: 300 });
      const dataUrl = await imageToDataUrl(image);
      if (dataUrl) result.push({ dataUrl, alt: String(image.alt || "").trim() });
    }
    return result;
  }

  const BIG_IMAGE_MIN = 80;

  function bigImages(root) {
    const found = [];
    if (!root?.querySelectorAll) return found;
    for (const image of Array.from(root.querySelectorAll("img"))) {
      const rect = image.getBoundingClientRect();
      if (rect.width >= BIG_IMAGE_MIN && rect.height >= BIG_IMAGE_MIN) found.push(image);
    }
    return found;
  }

  // Snapshot of the answers that already exist before the prompt is sent, so the
  // images of the *next* answer can be told apart from earlier ones.
  function collectImageBaseline(selectors) {
    const roots = responseNodes(selectors);
    const scoped = roots.length ? roots.slice(-2) : [];
    const nodes = [];
    const srcs = new Set();
    for (const root of scoped) {
      for (const image of bigImages(root)) {
        nodes.push(image);
        const src = image.currentSrc || image.src || "";
        if (src) srcs.add(src);
      }
    }
    return { nodes, srcs, text: latestResponseText(selectors) };
  }

  function newImagesSince(selectors, baseline) {
    const roots = responseNodes(selectors);
    const scoped = roots.length ? roots.slice(-2) : [document.body];
    const found = [];
    for (const root of scoped) {
      for (const image of bigImages(root)) {
        if (baseline?.nodes?.includes(image)) continue;
        const src = image.currentSrc || image.src || "";
        if (src && baseline?.srcs?.has(src)) continue;
        if (!found.includes(image)) found.push(image);
      }
    }
    return found;
  }

  // Image answers usually carry no text, so waiting for text would idle until
  // the timeout and only then look for the picture. Watch for a new <img>
  // instead and return as soon as the answer has stopped generating.
  async function waitForGeneratedImages(selectors, baseline, { timeout = 180000 } = {}) {
    const startedAt = Date.now();
    const deadline = startedAt + timeout;
    let found = [];
    let changedAt = 0;
    while (Date.now() < deadline) {
      await sleep(1500);
      const current = newImagesSince(selectors, baseline);
      if (current.length !== found.length) {
        found = current;
        changedAt = Date.now();
      }
      if (found.length && !isGenerating() && Date.now() - changedAt >= 2500) break;
      // A finished text-only answer (a refusal, a usage limit, …) will never
      // produce an image: report it now instead of waiting out the timeout.
      if (!found.length && !isGenerating() && Date.now() - startedAt > 30000) {
        const said = latestResponseText(selectors);
        if (said && said !== String(baseline?.text || "")) break;
      }
    }
    if (!found.length) return [];
    const result = [];
    for (const image of found.slice(-10)) {
      await waitFor(() => image.complete && image.naturalWidth > 0, { timeout: 15000, interval: 300 });
      const dataUrl = await imageToDataUrl(image);
      if (dataUrl) result.push({ dataUrl, alt: String(image.alt || "").trim() });
    }
    return result;
  }

  async function attachImages(editor, dataUrls, attachSelectors = []) {
    let attached = 0;
    for (const dataUrl of dataUrls) {
      const blob = await (await fetch(dataUrl)).blob();
      const extension = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
      const file = new File([blob], `reference-${Date.now()}.${extension}`, { type: blob.type || "image/png" });
      const input = findFirst(attachSelectors, { requireVisible: false });
      if (input instanceof HTMLInputElement && input.type === "file") {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        dispatchInputEvents(input);
        attached += 1;
        await sleep(800);
        continue;
      }
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
      (editor || document.body).dispatchEvent(event);
      attached += 1;
      await sleep(800);
    }
    return attached;
  }

  function countAttachments(selectors) {
    return findFirst(selectors, { requireVisible: false }) ? 1 : 0;
  }

  let queue = Promise.resolve();

  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  function makeCancellationRegistry() {
    const cancelled = new Set();
    return {
      register(batchId) {
        if (!batchId) return;
        cancelled.add(String(batchId));
        if (cancelled.size > 128) cancelled.delete(cancelled.values().next().value);
      },
      check(batchId) {
        if (batchId && cancelled.has(String(batchId))) {
          const error = new Error("이미지 생성을 중지했습니다. 완성된 글과 이미지는 유지됩니다.");
          error.code = "IMAGE_BATCH_CANCELLED";
          throw error;
        }
      },
    };
  }

  async function submitPrompt(config, prompt, options = {}) {
    const {
      promptSelectors, sendSelectors, responseSelectors, attachSelectors = [],
    } = config;

    if (options.newChat && config.newChatSelectors?.length) {
      const newChat = findFirst(config.newChatSelectors, { requireVisible: true });
      if (newChat) {
        newChat.click();
        await sleep(1200);
      }
    }

    const editor = await waitFor(() => findFirst(promptSelectors), { timeout: 30000, interval: 300 });
    if (!editor) throw new Error("AI 입력창을 찾지 못했습니다. 해당 AI 사이트에 로그인되어 있는지 확인하세요.");

    const previousSignature = responseSignature(responseSelectors);
    const imageBaseline = options.imageMode ? collectImageBaseline(responseSelectors) : null;

    const filled = await fillPromptEditor(editor, prompt);
    if (!filled) throw new Error("AI 입력창에 프롬프트를 입력하지 못했습니다.");

    if (Array.isArray(options.inputImages) && options.inputImages.length) {
      await attachImages(editor, options.inputImages, attachSelectors);
    }

    await sleep(200);
    const sent = await clickSend(sendSelectors, editor);
    if (!sent) throw new Error("AI 전송 버튼을 찾지 못했습니다.");

    if (options.imageMode) {
      const images = await waitForGeneratedImages(responseSelectors, imageBaseline, {
        timeout: options.imageTimeoutMs || Math.min(Number(options.timeoutMs) || 180000, 300000),
      });
      const response = latestResponseText(responseSelectors);
      if (!images.length) {
        const said = response.slice(0, 200);
        throw new Error(
          "AI가 이미지를 만들지 않았습니다."
          + (said ? ` AI 응답: “${said}”` : "")
          + " AI 탭에서 요청이 거부되었는지(무료 사용량·로그인 상태) 확인한 뒤 다시 시도하세요.",
        );
      }
      return { response, images };
    }

    const response = await waitForAnswer(responseSelectors, previousSignature, {
      timeout: options.timeoutMs || 240000,
    });
    if (!response) {
      throw new Error("AI 응답을 읽지 못했습니다. AI 탭에서 응답이 끝났는지 확인한 뒤 다시 시도하세요.");
    }

    return { response, images: [] };
  }

  function collectImageCount(selectors) {
    const roots = responseNodes(selectors);
    const scoped = roots.length ? roots.slice(-2) : [document.body];
    let count = 0;
    for (const root of scoped) {
      for (const image of Array.from(root.querySelectorAll("img"))) {
        const rect = image.getBoundingClientRect();
        if (rect.width >= 80 && rect.height >= 80) count += 1;
      }
    }
    return count;
  }

  globalThis.DDALKKAK_AI = Object.freeze({
    sleep,
    waitFor,
    findFirst,
    findByText,
    visible,
    fillPromptEditor,
    clickSend,
    waitForAnswer,
    collectImages,
    collectImageCount,
    collectImageBaseline,
    newImagesSince,
    waitForGeneratedImages,
    attachImages,
    responseNodes,
    enqueue,
    makeCancellationRegistry,
    submitPrompt,
    describeElement,
    probeSelectors,
    diagnose,
  });

  // Single place that answers the panel's DOM diagnostic request. It reads the
  // adapter config registered by the site-specific script.
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "NB_AI_DIAGNOSE") return false;
      const adapter = globalThis.DDALKKAK_ADAPTER;
      if (!adapter?.config) {
        sendResponse({ ok: false, error: "AI 어댑터 설정을 찾지 못했습니다. 탭을 새로고침한 뒤 다시 시도하세요." });
        return false;
      }
      try {
        sendResponse({ ok: true, provider: adapter.provider, ...diagnose(adapter.config) });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
      return false;
    });
  }
})();
