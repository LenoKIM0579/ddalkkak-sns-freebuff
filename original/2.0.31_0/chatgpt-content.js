if (window.__chatgptContentScriptLoaded) {
  // 중복 주입 방지
} else {
  window.__chatgptContentScriptLoaded = true;

const promptSelectorCandidates = [
  "#prompt-textarea",
  'textarea[placeholder*="Message"]',
  'textarea[placeholder*="메시지"]',
  'div[contenteditable="true"][id="prompt-textarea"]',
  'div[contenteditable="true"][data-testid="composer-text-input"]',
  'div.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
  "textarea",
];

const sendButtonSelectorCandidates = [
  'button#composer-submit-button',
  'button[data-testid="send-button"]',
  'button[aria-label*="Send"]',
  'button[aria-label*="보내"]',
  'button[aria-label*="전송"]',
  'button[title*="Send"]',
  'button[aria-label*="送信"]',
  'button[aria-label*="Enviar"]',
];

const responseSelectorCandidates = [
  // ChatGPT can insert layout wrappers between the assistant turn and message.
  // Scope to assistant turns, but do not require the message to be a direct child.
  '[data-content-search-unit-key$=":assistant"] [data-chatgpt-selection-message-id]',
  '[data-chatgpt-search-unit-key$=":assistant"] [data-chatgpt-selection-message-id]',
  '[data-content-search-unit-key$=":assistant"] [data-markdown-text-style="assistant-message"]',
  '[data-chatgpt-search-unit-key$=":assistant"] [data-markdown-text-style="assistant-message"]',
  'section[data-turn="assistant"]',
  '[data-testid^="conversation-turn-"][data-turn="assistant"]',
  '.agent-turn',
  'div[data-message-author-role="assistant"]',
  'article [data-message-author-role="assistant"]',
  'main [data-message-author-role="assistant"]',
  'main article',
];

// ChatGPT image replies can omit the usual assistant-role wrappers. Their
// generated-image gallery still lives inside a search-message container.
const imageResponseSelector = '[data-chatgpt-search-message-ids]';

function getResponseContainers() {
  return Array.from(document.querySelectorAll([...responseSelectorCandidates, imageResponseSelector].join(",")))
    .filter((element) => !element.matches(imageResponseSelector) ||
      Boolean(element.querySelector('[data-testid="generated-image-gallery"]')))
    .filter(isVisible)
    .filter((element, index, all) => !all.some((other, otherIndex) =>
      otherIndex !== index && other.contains(element)));
}

const newChatSelectorCandidates = [
  'button[data-testid="new-chat-button"]',
  'a[data-testid="new-chat-button"]',
  'button[aria-label*="New chat"]',
  'a[aria-label*="New chat"]',
  'button[aria-label*="새 채팅"]',
  'a[aria-label*="새 채팅"]',
  'button[title*="New chat"]',
  'a[href="/"]',
];

const temporaryChatSelectorCandidates = [
  'button[data-testid="temporary-chat-button"]',
  'a[data-testid="temporary-chat-button"]',
  'button[aria-label*="Temporary chat"]',
  'a[aria-label*="Temporary chat"]',
  'button[aria-label*="Temporary"]',
  'a[aria-label*="Temporary"]',
  'button[aria-label*="임시 채팅"]',
  'a[aria-label*="임시 채팅"]',
  'button[title*="Temporary chat"]',
  'button[title*="Temporary"]',
  '[data-testid*="temporary"]',
];

const temporaryChatTextCandidates = [
  "temporary chat",
  "temporary",
  "임시 채팅",
  "임시채팅",
];

const imageModeSelectorCandidates = [
  'button[aria-label*="Create image"]',
  'button[aria-label*="create image"]',
  'button[aria-label*="이미지"]',
  'button[title*="Create image"]',
  'button[title*="이미지"]',
  '[data-testid*="image"]',
];

const imageModeTextCandidates = [
  "create image",
  "create an image",
  "image",
  "이미지",
];

const DEBUG_LOG_SOURCE = "chatgpt-content";

let submissionQueue = Promise.resolve();
const cancelledImageBatches = new Set();

function assertImageBatchNotCancelled(options) {
  if (options.imageBatchId && cancelledImageBatches.has(options.imageBatchId)) {
    const error = new Error('이미지 생성을 중지했습니다. 완성된 글과 이미지는 유지됩니다.');
    error.code = 'IMAGE_BATCH_CANCELLED';
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'NB_CANCEL_IMAGE_BATCH' && /^[a-zA-Z0-9_-]{16,100}$/.test(String(message.batchId || ''))) {
    cancelledImageBatches.add(message.batchId);
    if (cancelledImageBatches.size > 256) cancelledImageBatches.delete(cancelledImageBatches.values().next().value);
    sendResponse({ ok: true, cancelled: true });
    return false;
  }
  if (message?.type === "NB_CHATGPT_PING") {
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type !== "NB_CHATGPT_SUBMIT") {
    return false;
  }

  submissionQueue = submissionQueue
    .then(async () => {
      await appendDebugLog("submit.request.received", {
        promptLength: String(message.prompt || "").length,
        promptPreview: summarizeTextForLog(message.prompt || "", 180),
        options: sanitizeLogValue(message.options || {}),
      });
    })
    .then(() => submitPrompt(message.prompt, message.options || {}, message.requestId))
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) => {
      void appendDebugLog("submit.request.failed", {
        error: error?.message || String(error),
      });
      sendResponse({ ok: false, error: error?.message || String(error), errorCode: String(error?.code || '') });
    });

  return true;
});

async function submitPrompt(prompt, options, requestId) {
  if (options.imageBatchId) assertImageBatchNotCancelled(options);
  await reportSubmissionPhase(requestId, "preparing");
  await appendDebugLog("submit.started", {
    href: location.href,
    promptLength: String(prompt || "").length,
    promptPreview: summarizeTextForLog(prompt || "", 180),
    options: sanitizeLogValue(options),
  });

  const imageRequest = options.imageMode === true || options.collectImages === true;
  if (imageRequest) {
    await prepareRegularImageChat(options);
  } else if (options.temporaryChat === true) {
    const temporaryChatStarted = await tryStartTemporaryChat();
    if (temporaryChatStarted) await waitForNewChatReady();
    if (!temporaryChatStarted && options.newChat === true) {
      await tryStartNewChat();
    }
  } else if (options.newChat === true) {
    await tryStartNewChat();
  }

  let editor = await waitForPromptEditor();
  if (options.imageBatchId) assertImageBatchNotCancelled(options);
  const previousSignature = getLatestResponseSignature();
  const previousUserTurnCount = getUserTurnCount();
  // Selecting Images can replace/reset the composer. Finish that transition
  // before typing, then preserve Chat's inline tool token while replacing text.
  if (imageRequest) {
    await requireImageGenerationMode(options);
    editor = await waitForPromptEditor();
    if (options.imageBatchId) assertImageBatchNotCancelled(options);
  }
  await fillPromptEditor(editor, prompt, { preserveImageMode: imageRequest });
  await attachInputImages(editor, options.inputImages || [], options.requireAllInputImages === true);

  const hasInputImages = Array.isArray(options.inputImages) && options.inputImages.length > 0;
  const sendButtonTimeoutMs = options.imageMode === true || options.collectImages === true ? 45000 : 10000;
  const sendButton = await waitForSendButton(sendButtonTimeoutMs, prompt, {
    allowRefill: !hasInputImages, imageMode: imageRequest, imageBatchId: options.imageBatchId,
  });
  if (options.imageBatchId) assertImageBatchNotCancelled(options);
  const previousPath = location.pathname;
  const imageBaseline = options.collectImages === true ? captureImageResponseBaseline() : null;
  // A lost message channel is safe to retry only before this checkpoint.
  await reportSubmissionPhase(requestId, "send_started");
  if (options.imageBatchId) assertImageBatchNotCancelled(options);
  sendButton.click();
  await reportSubmissionPhase(requestId, "sent");

  await waitForSubmissionStart(previousSignature, previousUserTurnCount, previousPath);

  await appendDebugLog("submit.sent", {
    previousSignature,
    collectImages: options.collectImages === true,
  });

  return waitForCompletedResponse(previousSignature, {
    timeoutMs: options.timeoutMs || 240000,
    collectImages: options.collectImages === true,
    imageBatchId: options.imageBatchId,
    imageBaseline,
  });
}

async function waitForPromptEditor(timeoutMs = 45000) {
  const startedAt = Date.now();
  let previousEditor = null;
  let stableSince = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const editor = findFirstVisibleElement(promptSelectorCandidates);
    if (editor && editor === previousEditor && Date.now() - stableSince >= 2000) {
      return editor;
    }
    if (editor !== previousEditor) {
      previousEditor = editor;
      stableSince = Date.now();
    }
    await sleep(300);
  }

  throw new Error("ChatGPT 입력창을 찾지 못했습니다. ChatGPT에 로그인되어 있고 채팅 화면이 열려 있는지 확인해 주세요.");
}

async function waitForSendButton(timeoutMs = 30000, expectedPrompt = null, options = {}) {
  const startedAt = Date.now();
  let refillCount = 0;
  let lastRefillAt = 0;
  let readySince = 0;
  let readyEditor = null;

  while (Date.now() - startedAt < timeoutMs) {
    if (options.imageBatchId) assertImageBatchNotCancelled(options);
    if (options.imageMode && !isImageGenerationModeActive()) {
      // Reselecting a tool can reset the composer, including attached files.
      if (options.allowRefill === false) {
        throw chatGptImageError('IMAGE_TOOL_UNAVAILABLE', 'ChatGPT 이미지 생성 도구 선택을 확인하지 못했습니다. GPT 일반 채팅에서 이미지 도구를 확인해 주세요.');
      }
      await requireImageGenerationMode(options);
      await waitForPromptEditor();
      readyEditor = null;
      readySince = 0;
      continue;
    }
    const editor = findFirstVisibleElement(promptSelectorCandidates);
    // Text drafts tolerate UI normalization. Image requests also require all
    // prompt text to survive the tool transition (ignoring whitespace only).
    const editorHasText = Boolean(getPromptEditorText(editor).trim());
    const imagePromptMatches = !options.imageMode || expectedPrompt === null
      || getPromptEditorText(editor).replace(/\s+/g, ' ').trim() === String(expectedPrompt).replace(/\s+/g, ' ').trim();
    if ((!editorHasText || !imagePromptMatches) && options.allowRefill && editor && expectedPrompt !== null
      && refillCount < 2 && Date.now() - lastRefillAt >= 1500) {
      refillCount += 1;
      lastRefillAt = Date.now();
      await appendDebugLog("submit.editor.refilling", { attempt: refillCount, editorTag: editor.tagName });
      await fillPromptEditor(editor, expectedPrompt, { preserveImageMode: options.imageMode });
      continue;
    }
    // Filter every candidate: a disabled old button must not hide a ready one.
    // The composer ID can also represent a stop control while generating.
    const button = findFirstVisibleElement(sendButtonSelectorCandidates, element =>
      !isElementDisabled(element) && !/stop|중지|停止|detener/i.test(getElementLabel(element)) && element.getAttribute('data-testid') !== 'stop-button');
    if (button && editorHasText && imagePromptMatches && !isGenerating()) {
      if (readyEditor === editor && Date.now() - readySince >= 1000) return button;
      if (readyEditor !== editor) {
        readyEditor = editor;
        readySince = Date.now();
      }
    } else {
      readyEditor = null;
      readySince = 0;
    }
    await sleep(250);
  }

  const editor = findFirstVisibleElement(promptSelectorCandidates);
  const candidates = collectUniqueElements(sendButtonSelectorCandidates.flatMap(selector => Array.from(document.querySelectorAll(selector))));
  await appendDebugLog('submit.send_button.timeout', {
    editorFound: Boolean(editor),
    editorHasText: Boolean(getPromptEditorText(editor).trim()),
    refillCount,
    generating: isGenerating(),
    buttons: candidates.slice(0, 10).map(button => ({id:button.id, testId:button.getAttribute('data-testid'), visible:isVisible(button), disabled:Boolean(isElementDisabled(button))})),
  });
  if (!getPromptEditorText(editor).trim()) {
    throw new Error("ChatGPT 입력창이 비어 있습니다. GPT 창의 로그인과 로딩 상태를 확인한 뒤 다시 시도해 주세요.");
  }
  throw new Error("ChatGPT 보내기 버튼을 찾지 못했습니다.");
}

function getUserTurnCount() {
  return document.querySelectorAll('[data-content-search-unit-key$=":user"] > [data-chatgpt-selection-message-id], [data-chatgpt-search-unit-key$=":user"] > [data-chatgpt-selection-message-id], [data-message-author-role="user"]').length;
}

async function waitForSubmissionStart(previousSignature, previousUserTurnCount, previousPath, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (location.pathname !== previousPath || isGenerating() || getLatestResponseSignature() !== previousSignature
      || getUserTurnCount() > previousUserTurnCount) {
      await appendDebugLog("submit.delivery.confirmed", { href: location.href });
      return;
    }
    await sleep(250);
  }
  await appendDebugLog("submit.delivery.unconfirmed", { href: location.href });
  throw new Error("ChatGPT 전송을 확인하지 못했습니다. GPT 창에서 메시지가 실제로 제출됐는지 확인해 주세요.");
}

async function reportSubmissionPhase(requestId, phase) {
  if (!requestId) return;
  const result = await chrome.runtime.sendMessage({ type: "NB_CHATGPT_PHASE", requestId, phase });
  if (!result?.ok || !result?.recorded) {
    throw new Error("ChatGPT 전송 상태를 확인하지 못했습니다. 중복 전송을 막기 위해 중단합니다.");
  }
}

async function waitForCompletedResponse(previousSignature, options) {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs;
  const requiresImages = options.collectImages === true;
  let seenNewResponse = false;
  let lastText = "";
  let lastImageCount = 0;
  let stablePasses = 0;
  let lastFailureText = '';
  let failurePasses = 0;
  let lastImageSignature = '';

  while (Date.now() - startedAt < timeoutMs) {
    if (options.imageBatchId) assertImageBatchNotCancelled(options);
    const latest = getLatestResponse(options.imageBaseline || null);
    const hasNewSignature = latest.signature && latest.signature !== previousSignature;
    const hasContent = requiresImages ? latest.imageCount > 0 : (latest.text || latest.imageCount > 0);
    const imageFailure = requiresImages && hasNewSignature && latest.imageCount === 0
      && !isGenerating() ? getExplicitImageFailure(latest.text) : null;
    if (imageFailure) {
      failurePasses = latest.text === lastFailureText ? failurePasses + 1 : 0;
      lastFailureText = latest.text;
      if (failurePasses >= 2) {
        await appendDebugLog('response.image_unavailable', { code: imageFailure.code, textLength: latest.text.length });
        throw imageFailure;
      }
    } else {
      lastFailureText = '';
      failurePasses = 0;
    }

    if (hasNewSignature && hasContent) {
      seenNewResponse = true;
    }

    // A pause during reasoning or streaming is not a completed response.
    // Count stability only after generation has stopped, as with Gemini.
    if (isGenerating() || !hasNewSignature || !hasContent) {
      stablePasses = 0;
      lastText = "";
      lastImageCount = 0;
      lastImageSignature = '';
    } else if (seenNewResponse && hasContent) {
      if (latest.text === lastText && latest.imageCount === lastImageCount
        && (!requiresImages || latest.signature === lastImageSignature)) {
        stablePasses += 1;
      } else {
        stablePasses = 0;
        lastText = latest.text;
        lastImageCount = latest.imageCount;
        lastImageSignature = latest.signature;
      }

      if (stablePasses >= 2) {
        await appendDebugLog("response.completed", {
          previousSignature,
          timeoutMs,
          requiresImages,
          textLength: latest.text.length,
          imageCount: latest.imageCount,
          stablePasses,
        });
        return buildResponsePayload(latest, options.collectImages);
      }

    }

    await sleep(1200);
  }

  await appendDebugLog("response.timeout", {
    previousSignature,
    timeoutMs,
    requiresImages,
    seenNewResponse,
    lastTextLength: lastText.length,
    lastImageCount,
    responseCandidateCount: getResponseContainers().length,
    latestTextLength: getLatestResponse().text.length,
    generating: isGenerating(),
    // Record structure only, never prompts or response content.
    selectorCounts: responseSelectorCandidates.map(selector => ({
      selector, count: document.querySelectorAll(selector).length,
    })),
    assistantTurnCount: document.querySelectorAll('[data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]').length,
  });
  throw new Error("ChatGPT 응답 대기 시간이 초과되었습니다.");
}

async function buildResponsePayload(responseState, collectImages) {
  const images = collectImages && responseState.element
    ? await extractResponseImages(responseState.element, responseState.imageElements || null) : [];

  await appendDebugLog("response.payload.ready", {
    collectImages: Boolean(collectImages),
    textLength: String(responseState.text || "").length,
    imageCount: images.length,
  });

  return {
    text: responseState.text,
    images,
  };
}

function getInlineImagePills(editor) {
  return Array.from(editor.querySelectorAll('[data-inline-selection-pill][data-system-hint-type="picture_v2"]'));
}

function getPromptEditorText(editor) {
  if (!editor) return '';
  if (typeof editor.value === 'string') return editor.value;
  if (!getInlineImagePills(editor).length) return editor.innerText ?? editor.textContent ?? '';
  const clone = editor.cloneNode(true);
  getInlineImagePills(clone).forEach(pill => pill.remove());
  clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  clone.querySelectorAll('p,div,li,pre').forEach(block => block.append('\n'));
  return clone.textContent || '';
}

async function fillPromptEditor(editor, prompt, options = {}) {
  editor.focus();

  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(editor, prompt);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    const imagePill = options.preserveImageMode ? getInlineImagePills(editor)[0] : null;
    if (imagePill) {
      // Keep the editor-owned atom in place. Recreating its HTML would not
      // restore the tool selection in ProseMirror's internal document.
      range.setEndBefore(imagePill);
      if (range.toString()) {
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.execCommand("insertText", false, "");
      }
      const currentPill = getInlineImagePills(editor)[0];
      if (!currentPill) {
        throw chatGptImageError('IMAGE_TOOL_UNAVAILABLE', 'ChatGPT 이미지 생성 도구 선택을 확인하지 못했습니다. GPT 일반 채팅에서 이미지 도구를 확인해 주세요.');
      }
      range.selectNodeContents(editor);
      range.setStartAfter(currentPill);
    }
    selection?.removeAllRanges();
    selection?.addRange(range);
    // One editor transaction avoids duplicate text from asynchronous paste.
    document.execCommand("insertText", false, prompt);
  }
  await sleep(300);
  await appendDebugLog('submit.editor.filled', {
    editorHasText: Boolean(getPromptEditorText(editor).trim()),
    connected: editor.isConnected,
  });
}

function pasteTextIntoEditor(editor, text) {
  const dataTransfer = new DataTransfer();
  dataTransfer.setData("text/plain", text);

  try {
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    });
    editor.dispatchEvent(pasteEvent);
  } catch {
    const fallbackEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(fallbackEvent, "clipboardData", { configurable: true, value: dataTransfer });
    editor.dispatchEvent(fallbackEvent);
  }
}

async function attachInputImages(editor, inputImages, requireAll = false) {
  const images = normalizeInputImages(inputImages, requireAll ? 10 : 3);

  if (requireAll && images.length !== (Array.isArray(inputImages) ? inputImages.length : 0)) {
    throw new Error("요청한 사진을 모두 첨부할 수 없습니다. 이미지 형식과 개수를 확인하세요.");
  }

  if (!images.length) {
    return;
  }

  let attachedCount = 0;

  for (const image of images) {
    try {
      const file = dataUrlToFile(image.dataUrl, image.name, image.type);
      const attachedByInput = await attachImageWithFileInput(file);

      if (!attachedByInput) {
        pasteImageFileIntoEditor(editor, file);
      }

      attachedCount += 1;
      await sleep(900);
    } catch (error) {
      await appendDebugLog("input.image.attach.failed", {
        name: image.name,
        error: error?.message || String(error),
      });
    }
  }

  await appendDebugLog("input.images.attached", {
    requestedCount: images.length,
    attachedCount,
  });
  if (requireAll && attachedCount !== images.length) {
    throw new Error(`사진 ${images.length}장 중 ${attachedCount}장만 첨부했습니다. 전송을 중지합니다.`);
  }
}

function normalizeInputImages(inputImages, maxImages = 3) {
  return Array.isArray(inputImages)
    ? inputImages
      .map((image) => ({
        dataUrl: String(image?.dataUrl || "").trim(),
        name: sanitizeFileName(image?.name || "reference-image"),
        type: String(image?.type || "").trim(),
      }))
      .filter((image) => image.dataUrl.startsWith("data:image/"))
      .slice(0, maxImages)
    : [];
}

async function attachImageWithFileInput(file) {
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
    .filter((input) => !input.disabled && acceptsImageFile(input, file));

  for (const input of inputs.reverse()) {
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);

      try {
        input.files = dataTransfer.files;
      } catch {
        Object.defineProperty(input, "files", { configurable: true, value: dataTransfer.files });
      }

      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(500);
      return true;
    } catch {
      // Try the next file input.
    }
  }

  return false;
}

function pasteImageFileIntoEditor(editor, file) {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);

  try {
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    });
    editor.dispatchEvent(pasteEvent);
  } catch {
    const fallbackEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(fallbackEvent, "clipboardData", { configurable: true, value: dataTransfer });
    editor.dispatchEvent(fallbackEvent);
  }
}

function acceptsImageFile(input, file) {
  const accept = String(input.accept || "").toLowerCase();

  if (!accept) {
    return true;
  }

  const type = String(file.type || "").toLowerCase();
  const extension = `.${String(file.name || "").split(".").pop().toLowerCase()}`;

  return accept.includes("image") || accept.includes(type) || accept.includes(extension);
}

function dataUrlToFile(dataUrl, name, fallbackType) {
  const safeDataUrl = String(dataUrl || "");
  const commaIndex = safeDataUrl.indexOf(",");

  if (commaIndex < 0) {
    throw new Error("첨부 이미지 data URL 형식이 올바르지 않습니다.");
  }

  const header = safeDataUrl.slice(0, commaIndex);
  const data = safeDataUrl.slice(commaIndex + 1);
  const type = (/^data:([^;,]+)/i.exec(header)?.[1] || fallbackType || "image/png").toLowerCase();
  const binary = /;base64/i.test(header) ? atob(data) : decodeURIComponent(data);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new File([bytes], ensureImageFileName(name, type), { type });
}

function ensureImageFileName(name, type) {
  const safeName = sanitizeFileName(name || "reference-image");

  if (/\.(png|jpe?g|webp|gif)$/i.test(safeName)) {
    return safeName;
  }

  const extension = type.includes("jpeg") ? "jpg" : type.includes("webp") ? "webp" : type.includes("gif") ? "gif" : "png";
  return `${safeName}.${extension}`;
}

function sanitizeFileName(value) {
  return String(value || "reference-image")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "reference-image";
}

async function tryStartNewChat() {
  // An already-empty start page is safe even when the sidebar is collapsed.
  if (isFreshChatPage()) {
    await appendDebugLog("new.chat.ready", { alreadyFresh: true });
    return;
  }
  const button = findFirstVisibleElement(newChatSelectorCandidates);
  if (!button || isElementDisabled(button)) {
    await appendDebugLog("new.chat.skipped", {
      reason: "button_not_found_or_disabled",
    });
    throw new Error("새 대화를 시작하지 못했습니다. AI 사이트에서 새 대화를 연 뒤 다시 시도해 주세요. 기존 대화에는 요청을 보내지 않았습니다.");
  }

  button.click();
  await appendDebugLog("new.chat.clicked", {
    label: summarizeTextForLog(getElementLabel(button), 120),
  });
  await sleep(1200);
  await waitForNewChatReady();
}

function isFreshChatPage() {
  return /^\/$/.test(location.pathname) && !getLatestResponseSignature();
}

async function waitForNewChatReady() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (isFreshChatPage()) {
      await appendDebugLog("new.chat.ready", { href: location.href });
      return;
    }
    await sleep(250);
  }
  await appendDebugLog("new.chat.failed", {
    reason: "fresh_page_not_confirmed", href: location.href,
    hasPreviousResponse: Boolean(getLatestResponseSignature()),
  });
  throw new Error("새 대화 전환을 확인하지 못했습니다. AI 사이트에서 새 대화를 연 뒤 다시 시도해 주세요. 기존 대화에는 요청을 보내지 않았습니다.");
}

async function tryStartTemporaryChat() {
  const button = findTemporaryChatButton();
  if (!button || isElementDisabled(button)) {
    await appendDebugLog("temporary.chat.skipped", {
      reason: "button_not_found_or_disabled",
    });
    return false;
  }

  activateElement(button);
  await appendDebugLog("temporary.chat.clicked", {
    label: summarizeTextForLog(getElementLabel(button), 120),
  });
  await sleep(1400);
  return true;
}

function chatGptImageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isTemporaryChatActive() {
  if (new URL(location.href).searchParams.get('temporary-chat') === 'true') return true;
  const button = findTemporaryChatButton();
  if (!button) return false;
  return /임시\s*채팅\s*끄기|turn off temporary|exit temporary|一時.*(?:終了|オフ)|desactivar.*temporal/i.test(getElementLabel(button))
    || ['aria-pressed', 'aria-selected', 'aria-checked'].some(name => button.getAttribute(name) === 'true');
}

async function prepareRegularImageChat(options) {
  if (options.imageBatchId) assertImageBatchNotCancelled(options);
  if (isTemporaryChatActive()) {
    const button = findTemporaryChatButton();
    if (!button || isElementDisabled(button)) {
      throw chatGptImageError('IMAGE_TOOL_UNAVAILABLE', 'ChatGPT 이미지 생성은 일반 채팅에서 진행합니다. GPT에서 임시 채팅을 끈 뒤 다시 시도해 주세요.');
    }
    activateElement(button);
    const deadline = Date.now() + 10000;
    while (isTemporaryChatActive() && Date.now() < deadline) {
      if (options.imageBatchId) assertImageBatchNotCancelled(options);
      await sleep(250);
    }
    if (isTemporaryChatActive()) {
      throw chatGptImageError('IMAGE_TOOL_UNAVAILABLE', 'ChatGPT 이미지 생성은 일반 채팅에서 진행합니다. GPT에서 임시 채팅을 끈 뒤 다시 시도해 주세요.');
    }
    // Leaving a temporary conversation must never reuse a pre-existing regular one.
    await tryStartNewChat();
  } else if (options.newChat === true) {
    await tryStartNewChat();
  }
  await appendDebugLog('image.chat.regular', { requestedTemporary: options.temporaryChat === true });
}

async function requireImageGenerationMode(options = {}) {
  if (options.imageBatchId) assertImageBatchNotCancelled(options);
  const selected = await ensureImageGenerationMode(10000, options);
  if (selected === false) {
    throw chatGptImageError('IMAGE_TOOL_UNAVAILABLE', 'ChatGPT 이미지 생성 도구 선택을 확인하지 못했습니다. GPT 일반 채팅에서 이미지 도구를 확인해 주세요.');
  }
}

function getExplicitImageFailure(text) {
  const value = String(text || '');
  if (/이미지[\s\S]{0,65}(?:한도[\s\S]{0,20}(?:도달|초과|소진)|제한에\s*도달)|(?:reached|exceeded|used up)[\s\S]{0,50}(?:image[\s\S]{0,25}limit)|image[\s\S]{0,40}limit[\s\S]{0,25}(?:reached|exceeded)|画像[\s\S]{0,40}(?:上限|制限)[\s\S]{0,20}(?:達|超)|(?:límite|cuota)[\s\S]{0,40}imágenes[\s\S]{0,30}(?:alcanz|agot)|(?:alcanz|agot)[\s\S]{0,40}(?:límite|cuota)[\s\S]{0,40}imágenes/i.test(value)) {
    return chatGptImageError('IMAGE_GENERATION_LIMIT', 'ChatGPT 이미지 생성 한도에 도달했습니다. 잠시 후 다시 시도하거나 다른 이미지 도구를 선택해 주세요.');
  }
  if (/이미지\s*생성\s*(?:도구|기능)[\s\S]{0,60}(?:사용할\s*수\s*없|사용이\s*불가|지원되지\s*않|비활성)|임시\s*채팅[\s\S]{0,40}이미지[\s\S]{0,40}(?:할\s*수\s*없|불가)|image\s*(?:generation|creation)?\s*tool[\s\S]{0,60}(?:unavailable|not available|disabled|not supported)|(?:cannot|can't|can’t)\s+(?:generate|create)\s+(?:an?\s+|any\s+)?images?\s+(?:in (?:this|temporary) (?:chat|session)|right now)|画像生成[\s\S]{0,40}(?:利用できません|使用できません|使えません)|(?:herramienta|generación) de imágenes[\s\S]{0,50}(?:no está disponible|no se puede|desactivad)/i.test(value)) {
    return chatGptImageError('IMAGE_TOOL_UNAVAILABLE', 'ChatGPT 이미지 생성 도구를 사용할 수 없습니다. 일반 채팅의 이미지 도구와 계정 상태를 확인해 주세요.');
  }
  return null;
}

async function ensureImageGenerationMode(timeoutMs = 10000, options = {}) {
  if (isImageGenerationModeActive()) {
    await appendDebugLog("image.mode.already_active", {});
    return true;
  }

  const startedAt = Date.now();

  let openedToolsMenu = false;
  let selectedButton = false;
  while (Date.now() - startedAt < timeoutMs) {
    if (options.imageBatchId) assertImageBatchNotCancelled(options);
    if (isImageGenerationModeActive()) {
      await appendDebugLog("image.mode.already_active", {});
      return true;
    }
    const button = findImageModeButton();
    if (!selectedButton && button && !isElementDisabled(button)) {
      selectedButton = true;
      activateElement(button);
      await appendDebugLog("image.mode.activated", {
        label: summarizeTextForLog(getElementLabel(button), 120),
      });
      await sleep(900);
      continue;
    }
    // Current GPT keeps image creation inside the composer's + menu.
    // Open it once; repeated clicks would toggle the menu closed again.
    if (!selectedButton && !openedToolsMenu) {
      const toolsButton = findComposerToolsButton();
      if (toolsButton && !isElementDisabled(toolsButton)) {
        openedToolsMenu = true;
        if (toolsButton.getAttribute("aria-expanded") !== "true") {
          activateElement(toolsButton);
          await appendDebugLog("image.mode.tools_menu.opened", {});
        }
      }
    }
    await sleep(250);
  }

  await appendDebugLog("image.mode.skipped", {
    reason: selectedButton ? "selection_not_confirmed" : "button_not_found",
    composerFound: Boolean(getChatGptComposerRoot()),
    scopedControlCount: getImageToolControls().length,
  });
  return false;
}

function getLatestResponse(imageBaseline = null) {
  if (imageBaseline) return getNewImageResponse(imageBaseline);
  const responseContainers = getResponseContainers();

  const matches = responseContainers
    .map((element) => ({
      element,
      text: normalizeText(element.innerText || element.textContent || ""),
      imageCount: getVisibleResponseImages(element).length,
    }))
    .filter((candidate) => candidate.text || candidate.imageCount > 0);

  const latest = matches.at(-1);

  if (!latest) {
    return { signature: "", text: "", imageCount: 0, element: null };
  }

  return {
    signature: `${matches.length}:${latest.text.slice(0, 160)}:${latest.imageCount}`,
    text: latest.text,
    imageCount: latest.imageCount,
    element: latest.element,
  };
}

function getLatestResponseSignature() {
  return getLatestResponse().signature;
}

function imageResponseKey(element) {
  const owner = element.closest('[data-chatgpt-search-message-ids], [data-chatgpt-selection-message-id], [data-message-id], [data-turn-id]');
  if (!owner) return '';
  return ['data-chatgpt-search-message-ids', 'data-chatgpt-selection-message-id', 'data-message-id', 'data-turn-id']
    .map(name => owner.getAttribute(name) || '').join(':');
}

function captureImageResponseBaseline() {
  const containers = getResponseContainers();
  return {
    containers: new Set(containers),
    keys: new Set(containers.map(imageResponseKey).filter(Boolean)),
    images: new Set(document.querySelectorAll('img')),
    sources: new Set(Array.from(document.querySelectorAll('img')).map(image => image.currentSrc || image.src).filter(Boolean)),
  };
}

function getNewImageResponse(baseline) {
  const imageElements = [];
  const sources = new Set();
  let lastContainer = null;
  for (const container of getResponseContainers()) {
    const key = imageResponseKey(container);
    if ((key ? baseline.keys.has(key) : baseline.containers.has(container))
      || container.closest('[data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"]')) continue;
    for (const image of getVisibleResponseImages(container)) {
      const source = image.currentSrc || image.src || '';
      if (!source || baseline.images.has(image) || baseline.sources.has(source) || sources.has(source)
        || !image.complete || image.naturalWidth <= 0
        || image.closest('[data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"]')) continue;
      sources.add(source);
      imageElements.push(image);
      lastContainer = container;
    }
  }
  if (!imageElements.length) {
    const latest = getLatestResponse();
    return { ...latest, imageCount: 0, imageElements: [] };
  }
  return {
    signature: `generated:${Array.from(sources).join('|')}`,
    text: '', imageCount: imageElements.length, element: lastContainer, imageElements,
  };
}

function getVisibleResponseImages(container) {
  const selectors = [
    "img",
    "figure img",
    "picture img",
  ];
  const images = collectUniqueElements(
    selectors.flatMap((selector) => Array.from(container.querySelectorAll(selector)))
  );

  const visibleImages = images.filter((image) => {
    if (!isVisible(image)) {
      return false;
    }

    const rect = image.getBoundingClientRect();
    return rect.width >= 96 && rect.height >= 96;
  });

  const seenSources = new Set();
  return visibleImages.filter((image) => {
    const source = image.currentSrc || image.src || "";
    const key = source || image.alt || `${Math.round(image.getBoundingClientRect().width)}x${Math.round(image.getBoundingClientRect().height)}`;

    if (seenSources.has(key)) {
      return false;
    }

    seenSources.add(key);
    return true;
  });
}

async function extractResponseImages(container, selectedImages = null) {
  const images = selectedImages || getVisibleResponseImages(container);
  const payloads = [];

  for (const image of images) {
    const dataUrl = await imageSourceToDataUrl(image.currentSrc || image.src);
    if (dataUrl) {
      payloads.push(dataUrl);
    }
  }

  await appendDebugLog("response.images.extracted", {
    visibleCount: images.length,
    convertedCount: payloads.length,
  });

  return payloads;
}

async function imageSourceToDataUrl(src) {
  if (!src) {
    return "";
  }
  if (src.startsWith("data:")) {
    return src;
  }

  if (/^https?:\/\//i.test(src)) {
    try {
      const remoteResult = await chrome.runtime.sendMessage({
        type: "NB_FETCH_IMAGE_AS_DATA_URL",
        url: src,
      });

      if (remoteResult?.ok && typeof remoteResult.dataUrl === "string" && remoteResult.dataUrl.startsWith("data:image/")) {
        return remoteResult.dataUrl;
      }
    } catch (error) {
      await appendDebugLog("response.image.remote_fetch_failed", {
        host: summarizeImageSourceHost(src),
        error: error?.message || String(error),
      });
    }

    // HTTP(S) 이미지는 콘텐츠 스크립트에서 직접 fetch하면 CORS에 막힐 수 있습니다.
    // 백그라운드 프록시가 실패한 경우 빈 값으로 종료해 브라우저 CORS 오류를 방지합니다.
    return "";
  }

  try {
    const response = await fetch(src);
    const blob = await response.blob();
    return await blobToDataUrl(blob);
  } catch {
    return "";
  }
}

function summarizeImageSourceHost(src) {
  try {
    return new URL(String(src || "")).hostname;
  } catch {
    return "";
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function isGenerating() {
  return Boolean(findFirstVisibleElement([
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="중지"]',
    'button[title*="Stop"]',
  ]));
}

function findImageModeButton() {
  const selectable = element => isImageModeElement(element) && !isImageModeRemoveElement(element);
  return getImageToolControls().find(element => isVisible(element) && selectable(element)) || null;
}

function getChatGptComposerRoot() {
  const editor = findFirstVisibleElement(promptSelectorCandidates);
  if (!editor) return null;
  const root = editor.closest('[data-composer-body], [data-testid="composer"], form');
  if (root) return root;
  // Older layouts lack a composer marker. Use the smallest ancestor with +.
  for (const parent of getAncestorChain(editor, 7)) {
    if (parent.matches('main, body, aside, nav, [role="navigation"]')) break;
    if (parent.querySelector('button[data-composer-navigation-target="add-context"], button[aria-label="Add files and more"], button[aria-label="파일 등 추가"]')) return parent;
  }
  return editor.parentElement;
}

function getImageToolControls() {
  const controls = 'button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="tab"], [role="option"]';
  const root = getChatGptComposerRoot();
  const menus = Array.from(document.querySelectorAll('[data-composer-overlay-floating-ui], [data-mention-list-scroll-area], [role="menu"], [role="listbox"], [data-radix-menu-content]'));
  const scoped = [root, ...menus].filter(Boolean).flatMap(node => Array.from(node.querySelectorAll(controls)));
  // Legacy creation buttons may lack a marked composer. Never accept a bare
  // sidebar "Images" or a button from a previous assistant/user response.
  const legacy = Array.from(document.querySelectorAll(controls)).filter(element => {
    if (element.closest('aside, nav, [role="navigation"], [data-message-author-role], [data-turn], [data-chatgpt-search-message-ids]')) return false;
    return (isImageModeElement(element) || isImageModeRemoveElement(element))
      && !/^(?:images?|이미지|画像|imágenes?|imagen)$/i.test(getElementLabel(element));
  });
  return collectUniqueElements([...scoped, ...legacy]).filter(element =>
    !element.closest('aside, nav, [role="navigation"], [data-message-author-role], [data-turn], [data-chatgpt-search-message-ids]'));
}

function isImageGenerationModeActive() {
  const editor = findFirstVisibleElement(promptSelectorCandidates);
  if (editor && getInlineImagePills(editor).some(isVisible)) return true;
  const removeButton = getImageToolControls()
    .find(element => isVisible(element) && isImageModeRemoveElement(element));
  if (removeButton) return true;
  const button = findImageModeButton();
  return Boolean(button && hasSelectedState(button));
}

function findComposerToolsButton() {
  return findFirstVisibleElement([
    'button[data-composer-navigation-target="add-context"]',
    'button[aria-label="파일 등 추가"]',
    'button[aria-label="Add files and more"]',
    'button[aria-label="Add photos and files"]',
    'button[aria-label="ファイルなどを追加"]',
    'button[aria-label="Añadir archivos y más"]',
  ]);
}

function isImageModeRemoveElement(element) {
  const label = getElementLabel(element).toLowerCase();
  return /remove|제거|削除|解除|eliminar|quitar/.test(label)
    && /image|이미지|画像|imagen/.test(label)
    && /creat|generat|생성|만들기|作成|生成|crear|generar|generación/.test(label);
}

function findTemporaryChatButton() {
  const exactMatch = findFirstVisibleElement(temporaryChatSelectorCandidates, isTemporaryChatElement);
  if (exactMatch) {
    return exactMatch;
  }

  const broadMatches = Array.from(document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="option"], [role="tab"]'));
  return broadMatches.find((element) => isVisible(element) && isTemporaryChatElement(element)) || null;
}

function isImageModeElement(element) {
  const label = getElementLabel(element).toLowerCase();
  return /create (?:an? )?image|generate (?:an? )?image|이미지\s*(?:생성|만들기)|画像(?:を)?(?:作成|生成)|(?:crear|generar)\s+(?:una\s+)?imagen/.test(label)
    || /^(?:image|이미지|画像|imagen)$/.test(label);
}

function isTemporaryChatElement(element) {
  const label = getElementLabel(element).toLowerCase();
  return temporaryChatTextCandidates.some((candidate) => label.includes(candidate));
}

function getElementLabel(element) {
  return normalizeText(
    element.getAttribute("aria-label")
      || element.getAttribute("title")
      || element.innerText
      || element.textContent
      || ""
  );
}

function hasSelectedState(element) {
  const nodes = [element, ...getAncestorChain(element, 3)];
  return nodes.some((node) => {
    const className = typeof node.className === "string" ? node.className : "";
    return node.getAttribute("aria-pressed") === "true"
      || node.getAttribute("aria-selected") === "true"
      || node.getAttribute("aria-checked") === "true"
      || node.getAttribute("data-selected") === "true"
      || /(?:^|\s)(?:selected|active|checked|current)(?:\s|$)/i.test(className);
  });
}

function getAncestorChain(element, maxDepth) {
  const nodes = [];
  let current = element.parentElement;

  while (current && nodes.length < maxDepth) {
    nodes.push(current);
    current = current.parentElement;
  }

  return nodes;
}

function activateElement(element) {
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus();
  element.click();
}

function findFirstVisibleElement(selectors, predicate = null) {
  for (const selector of selectors) {
    const matches = Array.from(document.querySelectorAll(selector));
    const visible = matches.find((element) => isVisible(element) && (!predicate || predicate(element)));
    if (visible) {
      return visible;
    }
  }
  return null;
}

function collectUniqueElements(elements) {
  return Array.from(new Set(elements));
}

function isElementDisabled(element) {
  return element.disabled || element.getAttribute("aria-disabled") === "true";
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function normalizeText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendDebugLog(event, details = {}) {
  try {
    await chrome.runtime.sendMessage({
      type: "NB_ADD_DEBUG_LOG",
      entry: {
        source: DEBUG_LOG_SOURCE,
        event,
        details,
      },
    });
  } catch {
    // Ignore debug logging failures.
  }
}

function summarizeTextForLog(value, maxLength = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}... (${text.length} chars)`;
}

function sanitizeLogValue(value, depth = 0) {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return summarizeTextForLog(value, 240);
  }

  if (depth >= 3) {
    return "[max-depth]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((entry) => sanitizeLogValue(entry, depth + 1));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 20)
        .map(([key, entryValue]) => [key, sanitizeLogValue(entryValue, depth + 1)])
    );
  }

  return summarizeTextForLog(String(value), 240);
}
}
