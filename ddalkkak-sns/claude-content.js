// Claude adapter. Claude has no image generation, so this provider is offered for
// text only.
(() => {
  if (globalThis.__ddalkkakClaudeLoaded) return;
  globalThis.__ddalkkakClaudeLoaded = true;

  const AI = globalThis.DDALKKAK_AI;

  const CONFIG = {
    promptSelectors: [
      'div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"][aria-label*="prompt"]',
      'div[contenteditable="true"][role="textbox"]',
      'fieldset div[contenteditable="true"]',
    ],
    sendSelectors: [
      'button[aria-label="Send message"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="보내기"]',
      'button[type="submit"]',
    ],
    responseSelectors: [
      '[data-testid="assistant-message"]',
      ".font-claude-message",
      'div[data-is-streaming]',
      ".font-claude-response",
    ],
    newChatSelectors: [
      'a[aria-label*="New chat"]',
      'button[aria-label*="New chat"]',
      'a[href="/new"]',
    ],
    attachSelectors: ['input[type="file"]'],
  };

  // Read by the shared diagnostic listener in ai-automation.js.
  globalThis.DDALKKAK_ADAPTER = Object.freeze({ provider: "claude", config: CONFIG });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "NB_CLAUDE_PING") {
      sendResponse({ ok: true, provider: "claude" });
      return false;
    }
    if (message?.type !== "NB_CLAUDE_SUBMIT") return false;

    AI.enqueue(() => AI.submitPrompt(CONFIG, String(message.prompt || ""), message.options || {}))
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error), errorCode: error?.code || "" }));
    return true;
  });
})();
