// Gemini adapter — receives prompt jobs from the service worker and answers with
// the visible response text plus any generated images.
(() => {
  if (globalThis.__ddalkkakGeminiLoaded) return;
  globalThis.__ddalkkakGeminiLoaded = true;

  const AI = globalThis.DDALKKAK_AI;
  const cancellation = AI.makeCancellationRegistry();

  const CONFIG = {
    promptSelectors: [
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div.ql-editor[contenteditable="true"]',
      'div[aria-label*="프롬프트 입력"]',
      'div[aria-label*="Enter a prompt"]',
      "textarea",
    ],
    sendSelectors: [
      'button[aria-label*="보내기"]',
      'button[aria-label*="Send message"]',
      'button[aria-label*="Send"]',
      'button[data-test-id="send-button"]',
      'button:has(mat-icon[fonticon="arrow_upward"])',
    ],
    responseSelectors: [
      "model-response",
      "response-container",
      ".response-container",
      'message-content[model-response]',
      'message-content',
      '[data-message-author-role="model"]',
    ],
    newChatSelectors: [
      'a[data-test-id="side-nav-sparkle-button"]',
      'button[aria-label*="New chat"]',
      'button[aria-label*="새 채팅"]',
      '[data-test-id="new-chat-button"]',
    ],
    attachSelectors: ['input[type="file"][accept*="image"]'],
  };

  // Read by the shared diagnostic listener in ai-automation.js.
  globalThis.DDALKKAK_ADAPTER = Object.freeze({ provider: "gemini", config: CONFIG });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "NB_CANCEL_IMAGE_BATCH") {
      cancellation.register(message.batchId);
      sendResponse({ ok: true, cancelled: true });
      return false;
    }
    if (message?.type === "NB_GEMINI_PING") {
      sendResponse({ ok: true, provider: "gemini" });
      return false;
    }
    if (message?.type !== "NB_GEMINI_SUBMIT") return false;

    const options = message.options || {};
    AI.enqueue(async () => {
      cancellation.check(options.imageBatchId);
      const payload = await AI.submitPrompt(CONFIG, String(message.prompt || ""), options);
      cancellation.check(options.imageBatchId);
      return payload;
    })
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error), errorCode: error?.code || "" }));
    return true;
  });
})();
