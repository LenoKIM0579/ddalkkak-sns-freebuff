// ChatGPT adapter. Image generation uses the normal chat: the prompt asks for one
// image and the generated <img> is read back from the answer.
(() => {
  if (globalThis.__ddalkkakChatGptLoaded) return;
  globalThis.__ddalkkakChatGptLoaded = true;

  const AI = globalThis.DDALKKAK_AI;
  const cancellation = AI.makeCancellationRegistry();

  const CONFIG = {
    promptSelectors: [
      "#prompt-textarea",
      'div[contenteditable="true"][data-id="root"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea[data-id="root"]',
      'form textarea',
    ],
    sendSelectors: [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send prompt"]',
      'button[aria-label*="Send message"]',
      'button[aria-label*="보내기"]',
    ],
    responseSelectors: [
      '[data-message-author-role="assistant"]',
      "article[data-testid^='conversation-turn']",
      ".markdown",
    ],
    newChatSelectors: [
      'a[data-testid="create-new-chat-button"]',
      'button[data-testid="create-new-chat-button"]',
      'a[aria-label*="New chat"]',
      'button[aria-label*="New chat"]',
      '[data-testid="new-chat-button"]',
    ],
    attachSelectors: ['input[type="file"]'],
  };

  // Read by the shared diagnostic listener in ai-automation.js.
  globalThis.DDALKKAK_ADAPTER = Object.freeze({ provider: "chatgpt", config: CONFIG });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "NB_CANCEL_IMAGE_BATCH") {
      cancellation.register(message.batchId);
      sendResponse({ ok: true, cancelled: true });
      return false;
    }
    if (message?.type === "NB_CHATGPT_PING") {
      sendResponse({ ok: true, provider: "chatgpt" });
      return false;
    }
    if (message?.type !== "NB_CHATGPT_SUBMIT") return false;

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
