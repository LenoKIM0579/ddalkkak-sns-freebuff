// Scoped image jobs only. Legacy text requests and user-opened AI tabs are untouched.
const imageBatchSessions = new Map();

function isImageBatchWindow(windowId) {
  return [...imageBatchSessions.values()].some(session => session.job?.windowId === windowId);
}

function recordImageBatchPhase(tabId, phase) {
  for (const session of imageBatchSessions.values()) {
    if (session.job?.tabId === tabId && !session.job.closing) session.job.phase = phase;
  }
}

function assertBackgroundImageBatch(batchId) {
  const session = imageBatchSessions.get(batchId);
  if (!session?.job || session.cancelled || session.job.error) {
    throw imageBatchError('IMAGE_BATCH_CANCELLED', '이미지 생성을 중지했습니다. 완성된 글과 이미지는 유지됩니다.');
  }
}

function imageBatchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getImageBatchSession(batchId, sender) {
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(String(batchId || ''))) {
    throw imageBatchError('IMAGE_BATCH_INVALID', '이미지 작업 정보를 확인하지 못했습니다. 다시 실행해 주세요.');
  }
  const owner = `${sender?.id || ''}:${sender?.documentId || 'panel'}`;
  let session = imageBatchSessions.get(batchId);
  if (session && session.owner !== owner) throw imageBatchError('IMAGE_BATCH_INVALID', '다른 패널의 이미지 작업은 제어할 수 없습니다.');
  if (!session) {
    // Retain cancellation tombstones, so a delayed request cannot reopen a stopped job.
    for (const [id, entry] of imageBatchSessions) {
      if (!entry.job && Date.now() - entry.touchedAt > 30 * 60 * 1000) imageBatchSessions.delete(id);
    }
    if (imageBatchSessions.size >= 256) throw imageBatchError('IMAGE_BATCH_INVALID', '이미지 작업이 너무 많습니다. 잠시 후 다시 실행해 주세요.');
    session = { owner, cancelled: false, job: null, touchedAt: Date.now() };
    imageBatchSessions.set(batchId, session);
  }
  session.touchedAt = Date.now();
  return session;
}

async function closeOwnedImagePopup(job) {
  if (!job.windowId) return false;
  const tabs = await chrome.tabs.query({windowId: job.windowId}).catch(() => []);
  if (!job.tabId && tabs.length !== 1) return false;
  const allowed = job.provider === 'chatgpt' ? isChatGptUrl : isGeminiUrl;
  const target = tabs.find(tab => (job.tabId ? tab.id === job.tabId : true) && allowed(tab.pendingUrl || tab.url || ''));
  // Do not close a moved/navigated tab, or another tab the user put in this popup.
  if (!target || target.windowId !== job.windowId) return false;
  job.closing = true;
  try {
    if (tabs.length === 1) await chrome.windows.remove(job.windowId);
    else await chrome.tabs.remove(target.id);
    return true;
  } catch {
    const remaining = job.tabId ? await getTabSafely(job.tabId) : null;
    if (remaining?.windowId === job.windowId && allowed(remaining.pendingUrl || remaining.url || '')) {
      try { await chrome.tabs.remove(remaining.id); return true; } catch {}
    }
    return false;
  }
}

async function cancelImageBatch(batchId, sender) {
  const session = getImageBatchSession(batchId, sender);
  session.cancelled = true;
  const job = session.job;
  job?.abort(imageBatchError('IMAGE_BATCH_CANCELLED', '이미지 생성을 중지했습니다. 완성된 글과 이미지는 유지됩니다.'));
  const closed = job ? await closeOwnedImagePopup(job) : false;
  await appendBackgroundDebugLog('image.batch.cancelled', { batchId, hadActiveJob: Boolean(job), closed }).catch(() => {});
  return { cancelled: true, closed };
}

async function runImageBatchPromptInPopup(provider, prompt, options, sender) {
  if (options.collectImages !== true || options.imageMode !== true) throw imageBatchError('IMAGE_BATCH_INVALID', '이미지 작업 정보를 확인하지 못했습니다. 다시 실행해 주세요.');
  const batchId = options.imageBatchId;
  const session = getImageBatchSession(batchId, sender);
  if (session.cancelled) throw imageBatchError('IMAGE_BATCH_CANCELLED', '이미지 생성을 중지했습니다. 완성된 글과 이미지는 유지됩니다.');
  if (session.job) throw imageBatchError('IMAGE_BATCH_INVALID', '이미지 작업이 이미 실행 중입니다.');
  if (!['gemini', 'chatgpt'].includes(provider)) throw imageBatchError('IMAGE_BATCH_INVALID', '이미지 생성 도구를 확인해 주세요.');
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  // Cancellation may arrive before the first awaited browser operation finishes.
  aborted.catch(() => {});
  const job = { provider, windowId: null, tabId: null, closing: false, phase: 'opening', error: null,
    abort(error) {
      if (!this.error && !this.closing) {
        this.error = error; session.cancelled = true;
        if (this.tabId && chrome.tabs.sendMessage) void chrome.tabs.sendMessage(this.tabId, {type: 'NB_CANCEL_IMAGE_BATCH', batchId}).catch(() => {});
        rejectAbort(error);
      }
    } };
  session.job = job;
  const check = () => {
    if (job.error) throw job.error;
    if (session.cancelled) throw imageBatchError('IMAGE_BATCH_CANCELLED', '이미지 생성을 중지했습니다. 완성된 글과 이미지는 유지됩니다.');
  };
  const removed = tabId => { if (tabId === job.tabId) job.abort(imageBatchError('IMAGE_POPUP_CLOSED', '이미지 생성 창이 닫혀 작업을 중단했습니다. 완성된 글과 이미지는 유지됩니다.')); };
  const windowRemoved = windowId => { if (windowId === job.windowId) job.abort(imageBatchError('IMAGE_POPUP_CLOSED', '이미지 생성 창이 닫혀 작업을 중단했습니다. 완성된 글과 이미지는 유지됩니다.')); };
  const detached = tabId => { if (tabId === job.tabId) job.abort(imageBatchError('IMAGE_CONTEXT_CHANGED', '이미지 생성 탭이 변경되어 작업을 중단했습니다. 완성된 글과 이미지는 유지됩니다.')); };
  const updated = (tabId, change) => {
    if (tabId !== job.tabId || !change.url) return;
    const allowed = provider === 'chatgpt' ? isChatGptUrl : isGeminiUrl;
    if (!allowed(change.url)) job.abort(imageBatchError('IMAGE_CONTEXT_CHANGED', '이미지 생성 탭이 변경되어 작업을 중단했습니다. 완성된 글과 이미지는 유지됩니다.'));
  };
  const bindings = [[chrome.tabs.onRemoved, removed], [chrome.windows.onRemoved, windowRemoved],
    [chrome.tabs.onDetached, detached], [chrome.tabs.onUpdated, updated]];
  for (const [event, listener] of bindings) event?.addListener(listener);
  const work = (async () => {
    const anchor = await getLastFocusedWindowSafe(); check();
    const createData = provider === 'chatgpt' ? buildChatGptPopupCreateData(anchor, true) : buildGeminiPopupCreateData(anchor, true);
    const popup = await chrome.windows.create(createData);
    job.windowId = popup.id;
    job.tabId = popup.tabs?.find(tab => tab.active)?.id || popup.tabs?.[0]?.id || null;
    if (session.cancelled || job.error) { await closeOwnedImagePopup(job); check(); }
    if (!job.windowId) throw new Error('이미지 생성 팝업 창을 만들지 못했습니다.');
    job.phase = 'preparing';
    const tab = provider === 'chatgpt'
      ? await waitForChatGptWindowPrimaryTab(job.windowId, TAB_COMPLETE_TIMEOUT_MS)
      : await waitForWindowPrimaryTab(job.windowId, TAB_COMPLETE_TIMEOUT_MS);
    job.tabId = tab.id; check();
    await waitForTabComplete(job.tabId, TAB_COMPLETE_TIMEOUT_MS); check();
    if (provider === 'chatgpt') await prepareChatGptTab(job.tabId, true);
    else await prepareGeminiTab(job.tabId, true);
    check();
    const current = await getTabSafely(job.tabId); check();
    const allowed = provider === 'chatgpt' ? isChatGptUrl : isGeminiUrl;
    if (!current || current.windowId !== job.windowId || !allowed(current.url || '')) throw imageBatchError('IMAGE_CONTEXT_CHANGED', '이미지 생성 탭이 변경되어 작업을 중단했습니다. 완성된 글과 이미지는 유지됩니다.');
    job.phase = 'submitting';
    const response = provider === 'chatgpt'
      ? await sendPromptToChatGpt(job.tabId, prompt, options)
      : await sendPromptToGemini(job.tabId, prompt, options);
    check();
    job.phase = 'completed';
    return { response, tabId: job.tabId };
  })();
  try {
    const result = await Promise.race([work, aborted]);
    const popupClosed = await closeOwnedImagePopup(job);
    return { ...result, popupClosed };
  } catch (error) {
    const current = job.tabId ? await getTabSafely(job.tabId).catch(() => null) : null;
    const code = job.error?.code || error?.code || (/message channel closed|message port closed|receiving end does not exist|extension context invalidated/i.test(error?.message || '')
      ? 'IMAGE_CHANNEL_CLOSED' : !current && job.tabId ? 'IMAGE_POPUP_CLOSED' : '');
    await appendBackgroundDebugLog('image.batch.popup.failed', {
      batchId, provider, code, phase: job.phase, tabPresent: Boolean(current),
      sameWindow: Boolean(current && current.windowId === job.windowId), status: current?.status || '',
    }).catch(() => {});
    if (code) error.code = code;
    throw job.error || error;
  } finally {
    // Mark closed before removing our own window, so cleanup is not a user cancellation.
    await closeOwnedImagePopup(job);
    for (const [event, listener] of bindings) event?.removeListener(listener);
    if (session.job === job) session.job = null;
    session.touchedAt = Date.now();
  }
}
