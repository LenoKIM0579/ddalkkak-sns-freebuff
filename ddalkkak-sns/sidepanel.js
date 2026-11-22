(() => {
  const DraftFormat = globalThis.ddalkkakDraftFormat;
  const Prompts = globalThis.ddalkkakPrompts;
  const Language = globalThis.ddalkkakLanguage;

  const SETTINGS_KEY = "ddalkkakPanelSettings";
  const DRAFT_KEY = "ddalkkakSavedDraft";
  const FIRST_USE_KEY = "ddalkkakFirstUseSeen";

  const STATE = {
    mode: "blog",
    draftMode: "manual",
    tone: "friendly",
    length: "medium",
    customLength: 2000,
    articleType: "auto",
    formatPreset: "auto",
    accentColor: "#7d9463",
    textProvider: "gemini",
    imageProvider: "gemini",
    chatMode: "new-chat",
    imageCount: "auto",
    imageRatio: "auto",
    imageStyle: "standard",
    language: "auto",
    draft: null,
    rawResponse: "",
    feedback: "",
    research: null,
    images: [],
    diagnostics: null,
    busy: false,
    stopRequested: false,
    activeBatchId: "",
    instagram: { caption: "", prompts: [], images: [], rawResponse: "" },
    threads: { posts: [], prompts: [], images: [], rawResponse: "" },
    access: null,
    photo: { photos: [], analysis: [], article: null, rawResponse: "" },
  };

  const $ = (id) => document.getElementById(id);
  const value = (id) => String($(id)?.value ?? "").trim();
  const setValue = (id, next) => {
    const node = $(id);
    if (node) node.value = next ?? "";
  };

  /* --------------------------------------------------------------- helpers -- */

  function appendLog(level, message) {
    const consoleNode = $("realtimeLogConsole");
    if (!consoleNode) return;
    const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
    const row = document.createElement("div");
    row.className = `log-item ${level}`;
    const stamp = document.createElement("span");
    stamp.className = "log-time";
    stamp.textContent = `[${time}]`;
    row.append(stamp, document.createTextNode(` ${message}`));
    consoleNode.append(row);
    while (consoleNode.children.length > 200) consoleNode.firstElementChild?.remove();
    consoleNode.scrollTop = consoleNode.scrollHeight;
  }

  function setStatus(id, message) {
    const node = $(id);
    if (node) node.textContent = message;
  }

  function setBusy(busy, label = "") {
    STATE.busy = busy;
    const buttons = [
      "bindTabButton", "bindTabNearInsertButton", "draftButton", "reviseDraftButton", "autoImageButton",
      "insertButton", "clearResultsButton", "copyHtmlButton", "instagramGenerateCaption",
      "instagramGenerateImages", "instagramGenerateAndInsert", "threadsGenerate",
      "threadsGenerateImages", "threadsGenerateAndInsert", "clearImagesButton",
      "photoGenerateButton", "photoInsertButton",
    ];
    for (const id of buttons) {
      const node = $(id);
      if (node) node.disabled = busy;
    }
    const stopButton = $("stopImageButton");
    if (stopButton) stopButton.disabled = !busy || !STATE.activeBatchId;
    if (busy && label) appendLog("info", label);
  }

  // A service worker stops after 30 seconds without events. AI answers can take
  // minutes, so ping it while a request is in flight; otherwise Chrome closes
  // the message channel and reports "message channel closed".
  let pendingCalls = 0;
  let keepAliveTimer = 0;

  function startKeepAlive() {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
      chrome.runtime.sendMessage({ type: "NB_KEEPALIVE" }).catch(() => {});
    }, 15000);
  }

  function stopKeepAlive() {
    if (!keepAliveTimer) return;
    clearInterval(keepAliveTimer);
    keepAliveTimer = 0;
  }

  async function sendMessage(type, payload = {}) {
    pendingCalls += 1;
    startKeepAlive();
    try {
      const response = await chrome.runtime.sendMessage({ type, ...payload }).catch((error) => ({
        ok: false,
        error: error?.message || String(error),
      }));
      if (!response?.ok) throw new Error(response?.error || "요청을 처리하지 못했습니다.");
      return response;
    } finally {
      pendingCalls -= 1;
      if (pendingCalls <= 0) {
        pendingCalls = 0;
        stopKeepAlive();
      }
    }
  }

  function errorMessage(error) {
    return error?.message || String(error || "알 수 없는 오류");
  }

  function reportError(target, error) {
    const message = errorMessage(error);
    appendLog("error", message);
    setStatus(target, message);
  }

  /* -------------------------------------------------------------- settings -- */

  async function loadSettings() {
    const stored = await chrome.storage.local.get([SETTINGS_KEY, DRAFT_KEY, FIRST_USE_KEY]);
    const saved = stored[SETTINGS_KEY] || {};
    const language = saved.language || "auto";
    STATE.language = language;
    setValue("uiLanguage", language);
    Language.applyLanguage(language);

    const fields = {
      postingModeInput: saved.mode || "blog",
      draftModeInput: saved.draftMode || "manual",
      topicInput: saved.topic || "",
      audienceInput: saved.audience || "",
      keywordsInput: saved.keywords || "",
      naverSearchKeywordInput: saved.searchKeyword || "",
      naverSearchReferenceCountInput: saved.referenceCount || "3",
      draftRequirementsInput: saved.requirements || "",
      toneInput: saved.tone || "friendly",
      lengthInput: saved.length || "medium",
      customLengthInput: saved.customLength || 2000,
      articleTypeInput: saved.articleType || "auto",
      formatPresetInput: saved.formatPreset || "auto",
      templateAccentColorInput: saved.accentColor || "#7d9463",
      textProviderInput: saved.textProvider || "gemini",
      imageProviderInput: saved.imageProvider || "gemini",
      chatSessionModeInput: saved.chatMode || "new-chat",
      autoImageCountInput: saved.imageCount ?? "auto",
      autoImageRatioInput: saved.imageRatio || "auto",
      autoImageStyleInput: saved.imageStyle || "standard",
      autoImageRequirementsInput: saved.imageRequirements || "",
      photoTopicInput: saved.photoTopic || "",
      photoContentInput: saved.photoContent || "",
      photoToneInput: saved.photoTone || "friendly",
      photoProviderInput: saved.photoProvider || "gemini",
      photoGuideInput: saved.photoGuide || "",
      photoUsageMode: saved.photoUsageMode || "all",
      photoUsageCountInput: saved.photoUsageCount || 5,
      instagramTopic: saved.instagramTopic || "",
      instagramImageStyle: saved.instagramImageStyle || "",
      instagramPostFormat: saved.instagramPostFormat || "standard",
      instagramImageCount: saved.instagramImageCount || "1",
      instagramProvider: saved.instagramProvider || "gemini",
      instagramImageProvider: saved.instagramImageProvider || "gemini",
      threadsTopic: saved.threadsTopic || "",
      threadsImageStyle: saved.threadsImageStyle || "",
      threadsPostFormat: saved.threadsPostFormat || "standard",
      threadsPostCount: saved.threadsPostCount || "1",
      threadsCount: saved.threadsCount || "0",
      threadsProvider: saved.threadsProvider || "gemini",
      threadsImageProvider: saved.threadsImageProvider || "gemini",
    };
    for (const [id, next] of Object.entries(fields)) setValue(id, next);

    STATE.mode = fields.postingModeInput;
    STATE.tone = fields.toneInput;
    STATE.length = fields.lengthInput;
    STATE.imageCount = String(fields.autoImageCountInput);
    STATE.imageRatio = fields.autoImageRatioInput;
    STATE.imageStyle = fields.autoImageStyleInput;
    STATE.accentColor = fields.templateAccentColorInput;

    const savedDraft = stored[DRAFT_KEY];
    if (savedDraft?.draft) {
      STATE.draft = savedDraft.draft;
      STATE.rawResponse = savedDraft.rawResponse || "";
      renderDraft();
      renderImages();
    }

    if (!stored[FIRST_USE_KEY]) openModal("firstUseNoticeModal");
    applyModeVisibility();
    updateCustomLengthVisibility();
    updateImageCountHint();
  }

  function collectSettings() {
    return {
      mode: value("postingModeInput") || "blog",
      draftMode: value("draftModeInput") || "manual",
      topic: value("topicInput"),
      audience: value("audienceInput"),
      keywords: value("keywordsInput"),
      searchKeyword: value("naverSearchKeywordInput"),
      referenceCount: value("naverSearchReferenceCountInput") || "3",
      requirements: value("draftRequirementsInput"),
      tone: value("toneInput"),
      length: value("lengthInput"),
      customLength: Number(value("customLengthInput")) || 2000,
      articleType: value("articleTypeInput"),
      formatPreset: value("formatPresetInput"),
      accentColor: value("templateAccentColorInput"),
      textProvider: value("textProviderInput"),
      imageProvider: value("imageProviderInput"),
      chatMode: value("chatSessionModeInput"),
      imageCount: value("autoImageCountInput"),
      imageRatio: value("autoImageRatioInput"),
      imageStyle: value("autoImageStyleInput"),
      imageRequirements: value("autoImageRequirementsInput"),
      photoTopic: value("photoTopicInput"),
      photoContent: value("photoContentInput"),
      photoTone: value("photoToneInput"),
      photoProvider: value("photoProviderInput"),
      photoGuide: value("photoGuideInput"),
      photoUsageMode: value("photoUsageMode"),
      photoUsageCount: Number(value("photoUsageCountInput")) || 5,
      instagramTopic: value("instagramTopic"),
      instagramImageStyle: value("instagramImageStyle"),
      instagramPostFormat: value("instagramPostFormat"),
      instagramImageCount: value("instagramImageCount"),
      instagramProvider: value("instagramProvider"),
      instagramImageProvider: value("instagramImageProvider"),
      threadsTopic: value("threadsTopic"),
      threadsImageStyle: value("threadsImageStyle"),
      threadsPostFormat: value("threadsPostFormat"),
      threadsPostCount: value("threadsPostCount"),
      threadsCount: value("threadsCount"),
      threadsProvider: value("threadsProvider"),
      threadsImageProvider: value("threadsImageProvider"),
      language: STATE.language,
    };
  }

  let persistTimer = 0;
  function persistSettings({ immediate = false } = {}) {
    clearTimeout(persistTimer);
    const write = () => chrome.storage.local.set({ [SETTINGS_KEY]: collectSettings() }).catch(() => {});
    if (immediate) write();
    else persistTimer = setTimeout(write, 400);
  }

  function persistDraft() {
    // Images are intentionally not persisted: a single batch can exceed the
    // storage quota and losing the draft would be worse than re-generating images.
    chrome.storage.local.set({
      [DRAFT_KEY]: {
        draft: STATE.draft,
        rawResponse: STATE.rawResponse,
        updatedAt: Date.now(),
      },
    }).catch(() => {});
  }

  /* ------------------------------------------------------------------ mode -- */

  function applyModeVisibility() {
    const mode = value("postingModeInput") || "blog";
    STATE.mode = mode;
    for (const card of document.querySelectorAll("[data-blog-only]")) {
      card.classList.toggle("hidden", mode !== "blog");
    }
    $("instagramCard")?.classList.toggle("hidden", mode !== "instagram");
    $("threadsCard")?.classList.toggle("hidden", mode !== "threads");
    $("photoCard")?.classList.toggle("hidden", mode !== "photo");
    $("photoUsageCountWrap")?.classList.toggle("hidden", value("photoUsageMode") !== "custom");
  }

  function updateCustomLengthVisibility() {
    $("customLengthGroup")?.classList.toggle("hidden", value("lengthInput") !== "custom");
  }

  function updateImageCountHint() {
    const count = value("autoImageCountInput");
    const available = Array.isArray(STATE.draft?.imagePrompts) ? STATE.draft.imagePrompts.length : 0;
    const hint = $("autoImageCountHint");
    if (!hint) return;
    hint.textContent = count === "auto"
      ? `초안의 프롬프트 ${available}개를 그대로 사용합니다.`
      : count === "0"
        ? "글만 만들고 이미지는 생성하지 않습니다."
        : `${count}장을 생성합니다. 초안 프롬프트가 부족하면 주제에 맞게 자동 보충합니다.`;
  }

  async function refreshContext() {
    try {
      const { context } = await sendMessage("NB_GET_CONTEXT");
      renderContext(context);
    } catch (error) {
      setStatus("contextStatus", errorMessage(error));
    }
  }

  function renderContext(context) {
    const statusNode = $("contextStatus");
    const metaNode = $("connectedTabMeta");
    if (!context?.boundTabUrl) {
      if (statusNode) statusNode.textContent = "연결된 글쓰기 탭이 없습니다. 글쓰기 화면에서 ‘① 현재 탭 연결하기’를 누르세요.";
      metaNode?.classList.add("hidden");
      return;
    }
    const labels = { naver: "네이버 블로그·카페", tistory: "티스토리", blogger: "Blogger", instagram: "Instagram", threads: "Threads" };
    if (statusNode) statusNode.textContent = `${labels[context.editorKind] || "글쓰기"} 탭이 연결되었습니다.`;
    if (metaNode) {
      metaNode.textContent = context.boundTabUrl;
      metaNode.classList.remove("hidden");
    }
    if (["instagram", "threads"].includes(context.editorKind)) {
      setValue("postingModeInput", context.editorKind);
      applyModeVisibility();
    }
  }

  async function bindActiveTab() {
    try {
      const result = await sendMessage("NB_BIND_ACTIVE_TAB");
      renderContext(result.context);
      if (result.editorReady === false) {
        appendLog("error", "탭은 연결됐지만 글쓰기 편집 영역이 아직 없습니다. 글쓰기 화면이 완전히 열린 뒤 다시 눌러 주세요.");
        const editor = result.editor;
        if (editor && !editor.error) {
          setStatus("contextStatus", "글쓰기 편집 영역을 찾지 못했습니다. 셀렉터 상태는 🩺 DOM 진단에서 확인할 수 있습니다.");
        }
      } else {
        appendLog("success", "현재 탭을 연결했습니다.");
      }
    } catch (error) {
      reportError("contextStatus", error);
    }
  }

  /* ----------------------------------------------------------------- draft -- */

  function draftStateForPrompt() {
    return {
      topic: value("topicInput") || value("naverSearchKeywordInput"),
      audience: value("audienceInput"),
      keywords: value("keywordsInput"),
      requirements: value("draftRequirementsInput"),
      tone: value("toneInput"),
      length: value("lengthInput"),
      customLength: Number(value("customLengthInput")) || 2000,
      articleType: value("articleTypeInput"),
      language: STATE.language,
    };
  }

  async function executeDraftRequest() {
    if (STATE.busy) return;
    const settings = draftStateForPrompt();
    const searchMode = value("draftModeInput") === "naver-search";

    if (!settings.topic && !searchMode) {
      setStatus("statusText", "주제를 입력하세요.");
      $("topicInput")?.focus();
      return;
    }

    setBusy(true);
    setStatus("statusText", "초안을 작성하는 중입니다...");
    appendLog("info", `초안 요청 · ${value("textProviderInput")}`);

    try {
      let research = null;
      if (searchMode) {
        const keyword = value("naverSearchKeywordInput");
        if (!keyword) throw new Error("검색 키워드를 입력하세요.");
        setStatus("statusText", "네이버 블로그 상위 글을 수집하는 중입니다...");
        research = (await sendMessage("NB_COLLECT_NAVER_RESEARCH", {
          keyword,
          maxResults: Number(value("naverSearchReferenceCountInput")) || 3,
        })).research;
        STATE.research = research;
        appendLog("success", `참고 글 ${research.references.length}개를 수집했습니다.`);
      }

      const prompt = Prompts.buildBlogDraftPrompt(settings, research);
      const result = await sendMessage("NB_SUBMIT_AI", {
        provider: value("textProviderInput"),
        prompt,
        options: { newChat: value("chatSessionModeInput") === "new-chat", temporaryChat: value("chatSessionModeInput") === "temporary" },
      });

      STATE.rawResponse = result.response;
      const draft = DraftFormat.parseDraftResponse(result.response, STATE.draft);
      if (!draft?.title && !draft?.content?.length) throw new Error("AI 응답에서 초안을 찾지 못했습니다. 다시 시도하세요.");
      STATE.draft = draft;
      renderDraft();
      persistDraft();
      setStatus("statusText", "초안이 준비되었습니다. 필요하면 수정 요청을 반영하세요.");
      appendLog("success", `초안 완료 · 소제목 ${draft.content.filter((block) => block.type === "heading").length}개 · 태그 ${draft.tags.length}개`);
    } catch (error) {
      reportError("statusText", error);
    } finally {
      setBusy(false);
      updateImageCountHint();
    }
  }

  async function reviseDraft() {
    if (STATE.busy) return;
    if (!STATE.draft) {
      setStatus("statusText", "먼저 초안을 작성하세요.");
      return;
    }
    const feedback = value("feedbackInput");
    if (!feedback) {
      $("feedbackInput")?.focus();
      setStatus("statusText", "수정 요청을 입력하세요.");
      return;
    }

    setBusy(true);
    setStatus("statusText", "수정 요청을 반영하는 중입니다...");
    try {
      const prompt = Prompts.buildRevisionPrompt(STATE.draft, feedback, {
        articleType: value("articleTypeInput"),
        formatPreset: value("formatPresetInput"),
        language: STATE.language,
      });
      const result = await sendMessage("NB_SUBMIT_AI", {
        provider: value("textProviderInput"),
        prompt,
        options: { newChat: false },
      });
      STATE.rawResponse = result.response;
      const draft = DraftFormat.parseDraftResponse(result.response, STATE.draft);
      STATE.draft = draft;
      renderDraft();
      persistDraft();
      setStatus("statusText", "수정 요청을 반영했습니다.");
      appendLog("success", "초안 수정 완료");
    } catch (error) {
      reportError("statusText", error);
    } finally {
      setBusy(false);
    }
  }

  function renderDraft() {
    const draft = STATE.draft;
    const empty = $("draftEmpty");
    const view = $("draftView");
    if (!draft) {
      empty?.classList.remove("hidden");
      view?.classList.add("hidden");
      updateImageCountHint();
      return;
    }
    empty?.classList.add("hidden");
    view?.classList.remove("hidden");
    const titleNode = $("draftTitle");
    if (titleNode) titleNode.textContent = draft.title || "(제목 없음)";
    const summaryNode = $("draftSummary");
    if (summaryNode) summaryNode.textContent = draft.summary || "";
    const tagList = $("tagList");
    if (tagList) {
      tagList.textContent = "";
      for (const tag of draft.tags || []) {
        const chip = document.createElement("span");
        chip.textContent = `#${tag}`;
        tagList.append(chip);
      }
    }
    const preview = $("draftPreview");
    if (preview) {
      preview.innerHTML = DraftFormat.blocksToHtml(draft.content, {
        preset: value("formatPresetInput"),
        accentColor: value("templateAccentColorInput"),
        articleType: value("articleTypeInput"),
      });
      for (const image of STATE.images) {
        const figure = document.createElement("img");
        figure.src = image.dataUrl;
        figure.alt = image.alt || "";
        figure.style.cssText = "display:block;width:100%;border-radius:12px;margin:16px 0;";
        preview.append(figure);
      }
    }
    updateImageCountHint();
  }

  function draftHtml() {
    if (!STATE.draft) return "";
    return DraftFormat.blocksToHtml(STATE.draft.content, {
      preset: value("formatPresetInput"),
      accentColor: value("templateAccentColorInput"),
      articleType: value("articleTypeInput"),
    });
  }

  async function copyHtml() {
    if (!STATE.draft) {
      setStatus("statusText", "복사할 초안이 없습니다.");
      return;
    }
    try {
      await navigator.clipboard.writeText(draftHtml());
      setStatus("statusText", "HTML을 클립보드에 복사했습니다.");
      appendLog("success", "HTML 복사 완료");
    } catch (error) {
      reportError("statusText", error);
    }
  }

  function clearResults() {
    STATE.draft = null;
    STATE.rawResponse = "";
    STATE.images = [];
    STATE.research = null;
    setValue("feedbackInput", "");
    renderDraft();
    renderImages();
    persistDraft();
    setStatus("statusText", "결과를 초기화했습니다.");
    $("rawOutput")?.classList.add("hidden");
  }

  /* ---------------------------------------------------------------- images -- */

  function imagePromptEntries(targetCount) {
    const base = Array.isArray(STATE.draft?.imagePrompts) ? [...STATE.draft.imagePrompts] : [];
    if (!base.length && STATE.draft?.title) {
      base.push({ slot: "대표 이미지", prompt: `${STATE.draft.title}에 어울리는 대표 이미지`, alt: STATE.draft.title, placementHint: "도입부 뒤", headingHint: "" });
    }
    while (base.length < targetCount) {
      base.push({
        slot: `추가 이미지 ${base.length + 1}`,
        prompt: `${STATE.draft?.title || "글"} 주제를 시각적으로 설명하는 이미지`,
        alt: STATE.draft?.title || "",
        placementHint: "문단 중간 배치",
        headingHint: "",
      });
    }
    return base.slice(0, targetCount);
  }

  async function generateImagesFor(targetCount, entries, provider, sink, options = {}) {
    const batchId = crypto.randomUUID();
    STATE.activeBatchId = batchId;
    STATE.stopRequested = false;
    const contextTitle = options.title || STATE.draft?.title || "";
    const batchMode = options.mode || STATE.imageStyle;
    let created = 0;

    for (let index = 0; index < entries.length; index += 1) {
      if (STATE.stopRequested) {
        appendLog("info", "사용자가 중지를 요청했습니다. 완성된 이미지는 유지됩니다.");
        break;
      }
      const entry = entries[index];
      const mode = batchMode === "mixed"
        ? (index === 0 ? "standard" : "info-slide")
        : batchMode;
      const prompt = Prompts.buildSingleImagePrompt(entry, { title: contextTitle }, {
        mode,
        ratio: options.ratio || value("autoImageRatioInput"),
        style: options.style ?? value("autoImageRequirementsInput"),
      });
      appendLog("info", `이미지 ${index + 1}/${entries.length} 생성 중...`);
      try {
        const result = await sendMessage("NB_SUBMIT_AI", {
          provider,
          prompt,
          options: { newChat: true, imageMode: true, imageBatchId: batchId, imageTimeoutMs: 240000 },
        });
        const image = result.images?.[0];
        if (!image?.dataUrl) {
          appendLog("error", `이미지 ${index + 1}: 결과 이미지를 읽지 못했습니다.`);
          continue;
        }
        sink({ dataUrl: image.dataUrl, alt: entry.alt || entry.slot, slot: entry.slot, provider });
        created += 1;
        appendLog("success", `이미지 ${index + 1}/${entries.length} 생성 완료`);
      } catch (error) {
        if (errorMessage(error).includes("중지")) {
          appendLog("info", "이미지 생성을 중지했습니다.");
          break;
        }
        appendLog("error", `이미지 ${index + 1} 실패: ${errorMessage(error)}`);
      }
    }

    STATE.activeBatchId = "";
    return created;
  }

  async function autoImages() {
    if (STATE.busy) return;
    if (!STATE.draft) {
      setStatus("statusText", "먼저 초안을 작성하세요.");
      return;
    }
    const requested = value("autoImageCountInput");
    if (requested === "0") {
      setStatus("statusText", "이미지 개수가 '글만'으로 설정되어 있습니다.");
      return;
    }
    const available = Array.isArray(STATE.draft.imagePrompts) ? STATE.draft.imagePrompts.length : 0;
    const target = requested === "auto" ? Math.min(10, Math.max(1, available)) : Math.min(10, Number(requested) || 1);

    setBusy(true);
    setStatus("statusText", `이미지 ${target}장을 생성하는 중입니다...`);
    try {
      const created = await generateImagesFor(target, imagePromptEntries(target), value("imageProviderInput"), (image) => {
        STATE.images.push(image);
        renderImages();
      });
      persistDraft();
      setStatus("statusText", created ? `${created}장의 이미지를 생성했습니다.` : "이미지를 생성하지 못했습니다.");
      appendLog(created ? "success" : "error", `이미지 생성 ${created}/${target}`);
    } catch (error) {
      reportError("statusText", error);
    } finally {
      setBusy(false);
    }
  }

  function renderImages() {
    const gallery = $("imageGallery");
    if (!gallery) return;
    gallery.textContent = "";
    STATE.images.forEach((image, index) => {
      gallery.append(buildTile(image, index, {
        total: STATE.images.length,
        onRemove: () => {
          STATE.images.splice(index, 1);
          renderImages();
          persistDraft();
        },
        onMove: (direction) => {
          const target = index + direction;
          if (target < 0 || target >= STATE.images.length) return;
          [STATE.images[index], STATE.images[target]] = [STATE.images[target], STATE.images[index]];
          renderImages();
          persistDraft();
        },
      }));
    });
    const warning = $("imageStorageWarning");
    if (warning) {
      warning.classList.toggle("hidden", STATE.images.length === 0);
      warning.textContent = "이미지는 패널을 닫으면 사라집니다. 필요한 이미지는 다운로드해 두세요.";
    }
  }

  function buildTile(image, index, options = {}) {
    const tile = document.createElement("div");
    tile.className = "image-tile";

    const indexBadge = document.createElement("span");
    indexBadge.className = "tile-index";
    indexBadge.textContent = String(index + 1);
    const imageNode = document.createElement("img");
    imageNode.src = image.dataUrl;
    imageNode.alt = image.alt || `이미지 ${index + 1}`;
    imageNode.addEventListener("click", () => openImageZoom(image.dataUrl, image.alt || image.slot || ""));

    const bar = document.createElement("div");
    bar.className = "tile-bar";
    const download = document.createElement("button");
    download.className = "ghost";
    download.type = "button";
    download.textContent = "저장";
    download.addEventListener("click", () => downloadImage(image, index));
    bar.append(download);
    if (options.onRemove) {
      const remove = document.createElement("button");
      remove.className = "danger";
      remove.type = "button";
      remove.textContent = "삭제";
      remove.addEventListener("click", options.onRemove);
      bar.append(remove);
    }
    if (options.onMove) {
      const left = document.createElement("button");
      left.className = "ghost";
      left.type = "button";
      left.textContent = "←";
      left.disabled = index === 0;
      left.addEventListener("click", () => options.onMove(-1));
      const right = document.createElement("button");
      right.className = "ghost";
      right.type = "button";
      right.textContent = "→";
      right.disabled = index === (options.total || 0) - 1;
      right.addEventListener("click", () => options.onMove(1));
      bar.append(left, right);
    }

    tile.append(indexBadge, imageNode, bar);
    return tile;
  }

  function downloadImage(image, index) {
    const match = /^data:image\/([a-z+]+);base64,/i.exec(image.dataUrl || "");
    const extension = (match?.[1] || "png").replace("jpeg", "jpg").replace("+xml", "");
    const anchor = document.createElement("a");
    anchor.href = image.dataUrl;
    anchor.download = `ddalkkak-${Date.now()}-${index + 1}.${extension}`;
    anchor.click();
  }

  function openImageZoom(source, caption) {
    const modal = $("imageModal");
    const imageNode = $("modalImage");
    if (!modal || !imageNode) return;
    imageNode.src = source;
    const captionNode = $("modalCaption");
    if (captionNode) captionNode.textContent = caption || "";
    modal.classList.remove("hidden");
  }

  function stopImageGeneration() {
    STATE.stopRequested = true;
    if (STATE.activeBatchId) {
      void sendMessage("NB_CANCEL_IMAGE_BATCH", {
        provider: value("imageProviderInput"),
        batchId: STATE.activeBatchId,
      }).catch(() => {});
    }
    appendLog("info", "현재 이미지가 끝난 뒤 중지합니다.");
  }

  /* --------------------------------------------------------------- insertion -- */

  async function insertBlogPost() {
    if (STATE.busy) return;
    if (!STATE.draft) {
      setStatus("statusText", "먼저 초안을 작성하세요.");
      return;
    }
    setBusy(true);
    setStatus("statusText", "연결된 글쓰기창에 입력하는 중입니다...");
    try {
      const result = await sendMessage("NB_INSERT_POST", {
        payload: {
          title: STATE.draft.title,
          html: draftHtml(),
          text: STATE.draft.text,
          tags: STATE.draft.tags,
          images: STATE.images.map((image, index) => ({
            dataUrl: image.dataUrl,
            fileName: `ddalkkak-${Date.now()}-${index + 1}.png`,
          })),
        },
      });
      const insertion = result.insertion || {};
      const parts = [
        insertion.insertedText ? "본문 입력 완료" : "본문 입력 확인 필요",
        insertion.insertedImages ? `이미지 ${insertion.insertedImages}장` : "이미지 없음",
      ];
      if (insertion.titleInserted === false) parts.push("제목 미입력");
      if (insertion.degraded) parts.push("서식 없이 텍스트만 입력");
      setStatus("statusText", `${parts.join(" · ")}. 게시 버튼은 직접 눌러 주세요.`);
      appendLog("success", `입력 완료 · ${insertion.editorKind || "editor"}`);
    } catch (error) {
      reportError("statusText", error);
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------------------------------------- instagram -- */

  function renderInstagramPrompts() {
    const list = $("instagramPromptList");
    if (!list) return;
    list.textContent = "";
    STATE.instagram.prompts.forEach((entry, index) => {
      list.append(buildPromptEditor(entry, index, (patch) => {
        STATE.instagram.prompts[index] = { ...STATE.instagram.prompts[index], ...patch };
        persistSettings();
      }));
    });
  }

  function buildPromptEditor(entry, index, onChange) {
    const wrapper = document.createElement("div");
    wrapper.className = "prompt-item";
    const label = document.createElement("span");
    label.className = "prompt-label";
    label.textContent = `이미지 ${index + 1} · ${entry.title || entry.slot || "설명"}`;

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.placeholder = "장별 문구";
    titleInput.value = entry.title || "";
    titleInput.addEventListener("input", () => onChange({ title: titleInput.value }));

    const promptInput = document.createElement("textarea");
    promptInput.rows = 3;
    promptInput.placeholder = "이미지 프롬프트";
    promptInput.value = entry.prompt || "";
    promptInput.addEventListener("input", () => onChange({ prompt: promptInput.value }));

    wrapper.append(label, titleInput, promptInput);
    return wrapper;
  }

  async function generateInstagramCaption() {
    if (STATE.busy) return;
    const topic = value("instagramTopic");
    if (!topic) {
      setStatus("instagramStatus", "주제를 입력하세요.");
      return;
    }
    setBusy(true);
    setStatus("instagramStatus", "캡션을 생성하는 중입니다...");
    try {
      const prompt = Prompts.buildInstagramCaptionPrompt({
        topic,
        imageCount: Number(value("instagramImageCount")) || 1,
        imageStyle: value("instagramImageStyle"),
        postFormat: value("instagramPostFormat"),
        language: STATE.language,
      });
      const result = await sendMessage("NB_SUBMIT_AI", {
        provider: value("instagramProvider"),
        prompt,
        options: { newChat: value("chatSessionModeInput") === "new-chat" },
      });
      const parsed = DraftFormat.parseJsonFromText(result.response) || {};
      const caption = String(parsed.caption || "").trim();
      if (!caption) throw new Error("캡션을 읽지 못했습니다. 다시 시도하세요.");
      STATE.instagram.caption = caption;
      STATE.instagram.rawResponse = result.response;
      STATE.instagram.prompts = (Array.isArray(parsed.images) ? parsed.images : []).map((entry, index) => ({
        title: String(entry?.title || ""),
        prompt: String(entry?.prompt || ""),
        alt: String(entry?.alt || ""),
        slot: `이미지 ${index + 1}`,
      }));
      setValue("instagramCaption", caption);
      updateInstagramCount();
      renderInstagramPrompts();
      setStatus("instagramStatus", `캡션과 이미지 프롬프트 ${STATE.instagram.prompts.length}개를 준비했습니다.`);
      appendLog("success", "Instagram 캡션 생성 완료");
    } catch (error) {
      reportError("instagramStatus", error);
    } finally {
      setBusy(false);
    }
  }

  function updateInstagramCount() {
    const node = $("instagramCount");
    if (node) node.textContent = `${value("instagramCaption").length} / 2,200자`;
  }

  async function generateInstagramImages() {
    if (STATE.busy) return;
    const count = Math.min(10, Math.max(1, Number(value("instagramImageCount")) || 1));
    const prompts = [...STATE.instagram.prompts];
    while (prompts.length < count) {
      prompts.push({
        title: "",
        prompt: `${value("instagramTopic") || "게시물"} 주제에 어울리는 이미지 ${prompts.length + 1}`,
        alt: "",
        slot: `이미지 ${prompts.length + 1}`,
      });
    }
    STATE.instagram.prompts = prompts.slice(0, count);
    renderInstagramPrompts();

    setBusy(true);
    setStatus("instagramStatus", `이미지 ${count}장을 생성하는 중입니다...`);
    try {
      STATE.instagram.images = [];
      const created = await generateImagesFor(count, STATE.instagram.prompts, value("instagramImageProvider"), (image) => {
        STATE.instagram.images.push(image);
        renderGallery($("instagramPreview"), STATE.instagram.images, (index) => {
          STATE.instagram.images.splice(index, 1);
          renderGallery($("instagramPreview"), STATE.instagram.images);
        });
      }, {
        title: value("instagramTopic"),
        mode: value("instagramPostFormat") === "cardnews" ? "info-slide" : "standard",
        style: value("instagramImageStyle"),
      });
      setStatus("instagramStatus", created ? `${created}장의 이미지를 생성했습니다.` : "이미지를 생성하지 못했습니다.");
    } catch (error) {
      reportError("instagramStatus", error);
    } finally {
      setBusy(false);
    }
  }

  async function insertInstagramPost() {
    if (STATE.busy) return;
    const caption = value("instagramCaption");
    if (!caption) {
      setStatus("instagramStatus", "캡션을 입력하세요.");
      return;
    }
    if (!STATE.instagram.images.length) {
      setStatus("instagramStatus", "이미지를 먼저 1장 이상 생성하세요.");
      return;
    }
    setBusy(true);
    setStatus("instagramStatus", "Instagram 게시물 화면에 입력하는 중입니다...");
    try {
      const result = await sendMessage("NB_INSERT_POST", {
        payload: {
          platform: "instagram",
          text: caption,
          images: STATE.instagram.images.map((image, index) => ({
            dataUrl: image.dataUrl,
            fileName: `instagram-${Date.now()}-${index + 1}.png`,
          })),
        },
      });
      const insertion = result.insertion || {};
      setStatus("instagramStatus", `이미지 ${insertion.insertedImages || 0}장과 캡션을 입력했습니다. 공유는 직접 눌러 주세요.`);
      appendLog("success", "Instagram 입력 완료 (공유하지 않음)");
    } catch (error) {
      reportError("instagramStatus", error);
    } finally {
      setBusy(false);
    }
  }

  /* ---------------------------------------------------------------- threads -- */

  function renderThreadsPosts() {
    const container = $("threadsPosts");
    if (!container) return;
    container.textContent = "";
    STATE.threads.posts.forEach((post, index) => {
      const wrapper = document.createElement("div");
      wrapper.className = "prompt-item";
      const label = document.createElement("span");
      label.className = "prompt-label";
      label.textContent = `글 ${index + 1} · ${String(post).length}/500자`;
      const textarea = document.createElement("textarea");
      textarea.rows = 4;
      textarea.value = post;
      textarea.addEventListener("input", () => {
        STATE.threads.posts[index] = textarea.value;
        label.textContent = `글 ${index + 1} · ${textarea.value.length}/500자`;
      });
      wrapper.append(label, textarea);
      container.append(wrapper);
    });
  }

  function renderThreadsPrompts() {
    const list = $("threadsPrompts");
    if (!list) return;
    list.textContent = "";
    STATE.threads.prompts.forEach((entry, index) => {
      list.append(buildPromptEditor(entry, index, (patch) => {
        STATE.threads.prompts[index] = { ...STATE.threads.prompts[index], ...patch };
      }));
    });
  }

  async function generateThreadsContent() {
    if (STATE.busy) return;
    const topic = value("threadsTopic");
    if (!topic) {
      setStatus("threadsStatus", "주제를 입력하세요.");
      return;
    }
    setBusy(true);
    setStatus("threadsStatus", "Threads 글을 작성하는 중입니다...");
    try {
      const prompt = Prompts.buildThreadsPrompt({
        topic,
        postCount: Number(value("threadsPostCount")) || 1,
        postFormat: value("threadsPostFormat"),
        imageStyle: value("threadsImageStyle"),
        language: STATE.language,
      });
      const result = await sendMessage("NB_SUBMIT_AI", {
        provider: value("threadsProvider"),
        prompt,
        options: { newChat: value("chatSessionModeInput") === "new-chat" },
      });
      const parsed = DraftFormat.parseJsonFromText(result.response) || {};
      const posts = (Array.isArray(parsed.posts) ? parsed.posts : [])
        .map((post) => String(post?.text || post || "").trim())
        .filter(Boolean);
      if (!posts.length) throw new Error("생성된 글을 읽지 못했습니다. 다시 시도하세요.");
      STATE.threads.posts = posts.slice(0, 10);
      STATE.threads.rawResponse = result.response;
      STATE.threads.prompts = (Array.isArray(parsed.images) ? parsed.images : []).map((entry, index) => ({
        title: String(entry?.title || ""),
        prompt: String(entry?.prompt || ""),
        alt: String(entry?.alt || ""),
        slot: `이미지 ${index + 1}`,
      }));
      renderThreadsPosts();
      renderThreadsPrompts();
      setStatus("threadsStatus", `글 ${STATE.threads.posts.length}개, 이미지 프롬프트 ${STATE.threads.prompts.length}개를 준비했습니다.`);
      appendLog("success", "Threads 글 생성 완료");
    } catch (error) {
      reportError("threadsStatus", error);
    } finally {
      setBusy(false);
    }
  }

  async function generateThreadsImages() {
    if (STATE.busy) return;
    const count = Math.min(10, Math.max(0, Number(value("threadsCount")) || 0));
    if (!count) {
      setStatus("threadsStatus", "이미지 개수를 1장 이상으로 선택하세요.");
      return;
    }
    const prompts = [...STATE.threads.prompts];
    while (prompts.length < count) {
      prompts.push({
        title: "",
        prompt: `${value("threadsTopic") || "Threads"} 주제에 어울리는 이미지 ${prompts.length + 1}`,
        alt: "",
        slot: `이미지 ${prompts.length + 1}`,
      });
    }
    STATE.threads.prompts = prompts.slice(0, count);
    renderThreadsPrompts();

    setBusy(true);
    setStatus("threadsStatus", `이미지 ${count}장을 생성하는 중입니다...`);
    try {
      STATE.threads.images = [];
      const created = await generateImagesFor(count, STATE.threads.prompts, value("threadsImageProvider"), (image) => {
        STATE.threads.images.push(image);
        renderGallery($("threadsPreview"), STATE.threads.images, (index) => {
          STATE.threads.images.splice(index, 1);
          renderGallery($("threadsPreview"), STATE.threads.images);
        });
      }, {
        title: value("threadsTopic"),
        mode: value("threadsPostFormat") === "cardnews" ? "info-slide" : "standard",
        style: value("threadsImageStyle"),
      });
      setStatus("threadsStatus", created ? `${created}장의 이미지를 생성했습니다.` : "이미지를 생성하지 못했습니다.");
    } catch (error) {
      reportError("threadsStatus", error);
    } finally {
      setBusy(false);
    }
  }

  async function insertThreadsPost() {
    if (STATE.busy) return;
    if (!STATE.threads.posts.length) {
      setStatus("threadsStatus", "글을 먼저 생성하세요.");
      return;
    }
    setBusy(true);
    setStatus("threadsStatus", "Threads 작성창에 입력하는 중입니다...");
    try {
      const result = await sendMessage("NB_INSERT_POST", {
        payload: {
          platform: "threads",
          text: STATE.threads.posts[0] || "",
          posts: STATE.threads.posts,
          images: STATE.threads.images.map((image, index) => ({
            dataUrl: image.dataUrl,
            fileName: `threads-${Date.now()}-${index + 1}.png`,
          })),
        },
      });
      const insertion = result.insertion || {};
      setStatus("threadsStatus", `글 ${insertion.postsWritten || 0}개, 이미지 ${insertion.insertedImages || 0}장을 입력했습니다. 게시는 직접 눌러 주세요.`);
      appendLog("success", "Threads 입력 완료 (게시하지 않음)");
    } catch (error) {
      reportError("threadsStatus", error);
    } finally {
      setBusy(false);
    }
  }

  function renderGallery(container, images, onRemove) {
    if (!container) return;
    container.textContent = "";
    images.forEach((image, index) => {
      container.append(buildTile(image, index, onRemove ? { onRemove: () => onRemove(index) } : {}));
    });
  }

  /* ------------------------------------------------------------ photo mode -- */

  function readPhotoFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const image = new Image();
        image.onload = () => {
          const maxSide = 1600;
          const ratio = Math.min(1, maxSide / Math.max(image.width || 1, image.height || 1));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round((image.width || 1) * ratio));
          canvas.height = Math.max(1, Math.round((image.height || 1) * ratio));
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve({
            name: file.name,
            dataUrl: canvas.toDataURL("image/jpeg", 0.86),
            width: canvas.width,
            height: canvas.height,
          });
        };
        image.onerror = () => reject(new Error(file.name + " 이미지를 읽지 못했습니다."));
        image.src = String(reader.result || "");
      };
      reader.onerror = () => reject(new Error(file.name + " 파일을 읽지 못했습니다."));
      reader.readAsDataURL(file);
    });
  }

  async function addPhotoFiles(fileList) {
    const files = Array.from(fileList || []).slice(0, Math.max(0, 12 - STATE.photo.photos.length));
    for (const file of files) {
      if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) {
        appendLog("error", file.name + " 은 지원하지 않는 형식입니다.");
        continue;
      }
      if (file.size > 20 * 1024 * 1024) {
        appendLog("error", file.name + " 은 20MB를 넘습니다.");
        continue;
      }
      try {
        STATE.photo.photos.push(await readPhotoFile(file));
      } catch (error) {
        appendLog("error", errorMessage(error));
      }
    }
    renderPhotoGallery();
    setStatus("photoStatus", STATE.photo.photos.length
      ? "사진 " + STATE.photo.photos.length + "장이 준비되었습니다. 내용을 확인하고 ‘② AI 글 작성’을 누르세요."
      : "사진과 내용을 준비하면 글을 작성할 수 있습니다.");
  }

  function renderPhotoGallery() {
    const gallery = $("photoGallery");
    if (!gallery) return;
    gallery.textContent = "";
    STATE.photo.photos.forEach((photo, index) => {
      gallery.append(buildTile({ dataUrl: photo.dataUrl, alt: photo.name }, index, {
        total: STATE.photo.photos.length,
        onRemove: () => {
          STATE.photo.photos.splice(index, 1);
          renderPhotoGallery();
        },
        onMove: (direction) => {
          const target = index + direction;
          if (target < 0 || target >= STATE.photo.photos.length) return;
          [STATE.photo.photos[index], STATE.photo.photos[target]] = [STATE.photo.photos[target], STATE.photo.photos[index]];
          renderPhotoGallery();
        },
      }));
    });
  }

  async function generatePhotoArticle() {
    if (STATE.busy) return;
    const content = value("photoContentInput");
    if (!content) {
      setStatus("photoStatus", "작성할 내용을 입력하세요.");
      $("photoContentInput")?.focus();
      return;
    }
    if (!STATE.photo.photos.length) {
      setStatus("photoStatus", "사진을 1장 이상 선택하세요.");
      return;
    }

    const provider = value("photoProviderInput");
    const photos = STATE.photo.photos.slice(0, 12);
    const usageMode = value("photoUsageMode");
    const usageCount = usageMode === "custom"
      ? Math.min(photos.length, Math.max(1, Number(value("photoUsageCountInput")) || 1))
      : photos.length;

    setBusy(true);
    setStatus("photoStatus", "사진을 분석하는 중입니다...");
    try {
      const analysis = [];
      for (let start = 0; start < photos.length; start += 4) {
        const batch = photos.slice(start, start + 4);
        try {
          const result = await sendMessage("NB_SUBMIT_AI", {
            provider,
            prompt: Prompts.buildPhotoAnalysisPrompt(batch.length),
            options: {
              newChat: start === 0,
              inputImages: batch.map((photo) => photo.dataUrl),
            },
          });
          const parsed = DraftFormat.parseJsonFromText(result.response) || {};
          const entries = Array.isArray(parsed.photos) ? parsed.photos : [];
          entries.forEach((entry, offset) => {
            analysis.push({ ...entry, index: start + offset + 1 });
          });
        } catch (error) {
          appendLog("error", "사진 분석 실패(" + (start + 1) + "~" + (start + batch.length) + "): " + errorMessage(error));
        }
      }
      STATE.photo.analysis = analysis;
      appendLog("info", "사진 분석 " + analysis.length + "/" + photos.length + "장 반영");

      setStatus("photoStatus", "글을 작성하는 중입니다...");
      const result = await sendMessage("NB_SUBMIT_AI", {
        provider,
        prompt: Prompts.buildPhotoArticlePrompt({
          topic: value("photoTopicInput"),
          content,
          tone: value("photoToneInput"),
          guide: value("photoGuideInput"),
          analysis,
          photoCount: photos.length,
          usageCount,
          language: STATE.language,
        }),
        options: { newChat: false },
      });

      const article = DraftFormat.parseDraftResponse(result.response, STATE.photo.article);
      if (!article?.title && !article?.content?.length) {
        throw new Error("AI 응답에서 글을 찾지 못했습니다. 다시 시도하세요.");
      }
      STATE.photo.article = article;
      STATE.photo.rawResponse = result.response;
      renderPhotoArticle();
      setStatus("photoStatus", "글을 완성했습니다. 사진 " + photos.length + "장 중 " + usageCount + "장을 배치했습니다. 확인 후 ‘④ 글쓰기창에 넣기’를 누르세요.");
      appendLog("success", "내 사진 글 작성 완료");
    } catch (error) {
      reportError("photoStatus", error);
    } finally {
      setBusy(false);
    }
  }

  function renderPhotoArticle() {
    const container = $("photoArticlePreview");
    const article = STATE.photo.article;
    if (!container) return;
    container.textContent = "";
    if (!article) return;

    const heading = document.createElement("h2");
    heading.className = "preview-title";
    heading.textContent = article.title || "(제목 없음)";
    const summary = document.createElement("p");
    summary.className = "summary";
    summary.textContent = article.summary || "";
    const body = document.createElement("div");
    body.innerHTML = DraftFormat.blocksToHtml(article.content, { preset: "magazine", photoSlots: true });

    for (const marker of Array.from(body.querySelectorAll("[data-photo-slot]"))) {
      const index = Number(marker.getAttribute("data-photo-slot"));
      const photo = STATE.photo.photos[index];
      if (!photo) {
        marker.remove();
        continue;
      }
      const image = document.createElement("img");
      image.src = photo.dataUrl;
      image.alt = photo.name || "";
      image.style.cssText = "display:block;width:100%;border-radius:12px;margin:12px 0;";
      marker.replaceWith(image);
    }

    const tagList = document.createElement("div");
    tagList.className = "tag-list";
    for (const tag of article.tags || []) {
      const chip = document.createElement("span");
      chip.textContent = "#" + tag;
      tagList.append(chip);
    }
    container.append(heading, summary, body, tagList);
  }

  async function insertPhotoArticle() {
    if (STATE.busy) return;
    const article = STATE.photo.article;
    if (!article) {
      setStatus("photoStatus", "먼저 ‘② AI 글 작성’을 눌러 글을 만드세요.");
      return;
    }
    setBusy(true);
    setStatus("photoStatus", "연결된 글쓰기창에 입력하는 중입니다...");
    try {
      const result = await sendMessage("NB_INSERT_POST", {
        payload: {
          title: article.title,
          html: DraftFormat.blocksToHtml(article.content, { preset: "magazine", photoSlots: true }),
          text: article.text,
          tags: article.tags,
          images: STATE.photo.photos.map((photo, index) => ({
            dataUrl: photo.dataUrl,
            fileName: "photo-" + Date.now() + "-" + (index + 1) + ".jpg",
          })),
        },
      });
      const insertion = result.insertion || {};
      setStatus("photoStatus", (insertion.insertedText ? "본문 입력 완료" : "본문 입력 확인 필요")
        + " · 사진 " + (insertion.insertedImages || 0) + "장. 게시는 직접 눌러 주세요.");
      appendLog("success", "사진 글 입력 완료 · " + (insertion.editorKind || "editor"));
    } catch (error) {
      reportError("photoStatus", error);
    } finally {
      setBusy(false);
    }
  }

  /* ---------------------------------------------------------------- access -- */

  function formatRemaining(remainingMs) {
    const minutes = Math.max(0, Math.round(Number(remainingMs || 0) / 60000));
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest ? hours + "시간 " + rest + "분" : hours + "시간";
    }
    return minutes + "분";
  }

  function renderAccess(access, endpoint) {
    STATE.access = access || null;
    const banner = $("accessStatusBanner");
    const icon = $("accessStatusIcon");
    const textNode = $("accessStatusText");
    if (!banner || !textNode) return;

    banner.classList.remove("idle", "active", "local");
    const set = (className, iconText, message) => {
      banner.classList.add(className);
      if (icon) icon.textContent = iconText;
      textNode.textContent = message;
    };

    if (!access) {
      set("idle", "🔒", "이용권 상태를 확인하지 못했습니다.");
    } else if (access.mode === "local") {
      set("local", "🟢", "로컬 모드 · 인증 서버가 없어 아무것도 차단하지 않습니다.");
    } else if (access.usable) {
      const label = { license: "라이선스", pass: "1시간 무료 이용권", membership: "YouTube 멤버십" }[access.mode] || "이용권";
      const detail = access.mode === "license"
        ? (access.userName || "사용자") + " · 만료 " + (access.expireDate || "-")
        : "남은 시간 " + formatRemaining(access.remainingMs);
      set("active", "✅", label + " 사용 중 · " + detail);
    } else {
      set("idle", "🔒", "이용권이 없습니다. 라이선스 키를 인증하거나 광고를 보고 1시간 무료 이용권을 받아 주세요.");
    }

    const openReward = $("openRewardButton");
    if (openReward) openReward.disabled = !access?.configured;
    $("verifyMembershipButton")?.classList.toggle("hidden", !access?.configured);

    const endpointInput = $("accessEndpointInput");
    if (endpointInput && endpoint !== undefined && document.activeElement !== endpointInput) {
      endpointInput.value = endpoint || "";
    }
  }

  async function refreshAccess() {
    try {
      const result = await sendMessage("NB_ACCESS_STATUS");
      renderAccess(result.access, result.endpoint);
    } catch (error) {
      appendLog("error", "이용권 상태 확인 실패: " + errorMessage(error));
    }
  }

  async function verifyLicense() {
    const key = value("licenseKeyInput");
    if (!key) {
      $("licenseKeyInput")?.focus();
      return;
    }
    try {
      const result = await sendMessage("NB_ACCESS_VERIFY_LICENSE", { licenseKey: key });
      renderAccess(result.access, value("accessEndpointInput"));
      appendLog("success", "라이선스를 인증했습니다.");
    } catch (error) {
      appendLog("error", errorMessage(error));
      setStatus("accessStatusText", errorMessage(error));
    }
  }

  async function clearLicense() {
    try {
      const result = await sendMessage("NB_ACCESS_CLEAR_LICENSE");
      renderAccess(result.access, value("accessEndpointInput"));
      $("licenseKeyInput") && ($("licenseKeyInput").value = "");
      appendLog("info", "라이선스 인증을 해제했습니다.");
    } catch (error) {
      appendLog("error", errorMessage(error));
    }
  }

  async function saveAccessEndpoint() {
    try {
      const result = await sendMessage("NB_ACCESS_SET_ENDPOINT", { endpoint: value("accessEndpointInput") });
      renderAccess(result.access, value("accessEndpointInput"));
      appendLog("success", "인증 서버 설정을 저장했습니다.");
    } catch (error) {
      appendLog("error", errorMessage(error));
    }
  }

  async function openReward() {
    const button = $("openRewardButton");
    if (button) button.disabled = true;
    try {
      const result = await sendMessage("NB_ACCESS_OPEN_REWARD", { language: STATE.language });
      renderAccess(result.access, value("accessEndpointInput"));
      $("claimRewardButton")?.classList.remove("hidden");
      appendLog("info", "광고 페이지를 열었습니다. 시청 후 ‘광고 시청 완료 새로고침’을 눌러 주세요.");
    } catch (error) {
      appendLog("error", errorMessage(error));
      setStatus("accessStatusText", errorMessage(error));
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function claimReward() {
    try {
      const result = await sendMessage("NB_ACCESS_CLAIM_REWARD");
      renderAccess(result.access, value("accessEndpointInput"));
      appendLog("success", "무료 이용권을 적용했습니다.");
    } catch (error) {
      appendLog("error", errorMessage(error));
      setStatus("accessStatusText", errorMessage(error));
    }
  }

  async function verifyMembership() {
    try {
      const result = await sendMessage("NB_ACCESS_VERIFY_MEMBERSHIP");
      renderAccess(result.access, value("accessEndpointInput"));
      appendLog("success", "YouTube 멤버십을 확인했습니다.");
    } catch (error) {
      appendLog("error", errorMessage(error));
      setStatus("accessStatusText", errorMessage(error));
    }
  }

  /* ----------------------------------------------------------------- modals -- */

  function openModal(id) {
    $(id)?.classList.remove("hidden");
  }

  function closeModal(id) {
    $(id)?.classList.add("hidden");
  }

  /* ------------------------------------------------------- settings io / log -- */

  function exportSettings() {
    const payload = { app: "ddalkkak-sns", version: 1, exportedAt: new Date().toISOString(), settings: collectSettings() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `ddalkkak-settings-${Date.now()}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 2000);
    appendLog("success", "설정을 내보냈습니다.");
  }

  async function importSettings(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const settings = parsed.settings || parsed;
      if (!settings || typeof settings !== "object") throw new Error("설정 파일을 읽을 수 없습니다.");
      for (const [key, next] of Object.entries(settings)) {
        const idByKey = {
          mode: "postingModeInput", draftMode: "draftModeInput", topic: "topicInput",
          audience: "audienceInput", keywords: "keywordsInput", searchKeyword: "naverSearchKeywordInput",
          referenceCount: "naverSearchReferenceCountInput", requirements: "draftRequirementsInput",
          tone: "toneInput", length: "lengthInput", customLength: "customLengthInput",
          articleType: "articleTypeInput", formatPreset: "formatPresetInput", accentColor: "templateAccentColorInput",
          textProvider: "textProviderInput", imageProvider: "imageProviderInput", chatMode: "chatSessionModeInput",
          imageCount: "autoImageCountInput", imageRatio: "autoImageRatioInput", imageStyle: "autoImageStyleInput",
          imageRequirements: "autoImageRequirementsInput", instagramTopic: "instagramTopic",
          instagramImageStyle: "instagramImageStyle", instagramPostFormat: "instagramPostFormat",
          instagramImageCount: "instagramImageCount", instagramProvider: "instagramProvider",
          instagramImageProvider: "instagramImageProvider", threadsTopic: "threadsTopic",
          threadsImageStyle: "threadsImageStyle", threadsPostFormat: "threadsPostFormat",
          threadsPostCount: "threadsPostCount", threadsCount: "threadsCount",
          threadsProvider: "threadsProvider", threadsImageProvider: "threadsImageProvider",
        };
        if (idByKey[key]) setValue(idByKey[key], next);
      }
      applyModeVisibility();
      updateCustomLengthVisibility();
      updateImageCountHint();
      persistSettings({ immediate: true });
      appendLog("success", "설정을 가져왔습니다.");
    } catch (error) {
      appendLog("error", `설정 가져오기 실패: ${errorMessage(error)}`);
    }
  }

  async function copyLog() {
    try {
      const { formattedLog } = await sendMessage("NB_GET_DEBUG_LOG");
      const visible = Array.from($("realtimeLogConsole")?.children || [])
        .map((row) => row.textContent || "")
        .join("\n");
      const text = [visible, "", "--- background log ---", formattedLog || "(비어 있음)"].join("\n");
      await navigator.clipboard.writeText(text);
      appendLog("success", "로그를 클립보드에 복사했습니다.");
    } catch (error) {
      appendLog("error", errorMessage(error));
    }
  }

  const DIAGNOSTIC_PROVIDERS = ["gemini", "chatgpt", "claude"];

  async function runDiagnostics() {
    const button = $("runDiagnosticsButton");
    if (button) button.disabled = true;
    setStatus("diagnosticsStatus", "진단 중입니다... AI 탭과 글쓰기 탭의 DOM을 확인하고 있습니다.");
    try {
      const result = await sendMessage("NB_DIAGNOSE");
      STATE.diagnostics = result.diagnostics || null;
      renderDiagnostics();
      appendLog("info", "DOM 진단을 완료했습니다.");
    } catch (error) {
      reportError("diagnosticsStatus", error);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function renderDiagnostics() {
    const diagnostics = STATE.diagnostics;
    if (!diagnostics) return;
    const output = $("diagnosticsOutput");
    if (output) {
      output.textContent = JSON.stringify(diagnostics, null, 2);
      output.classList.remove("hidden");
    }

    const mark = (value) => (value ? "✓" : "✗");
    const lines = [];
    for (const provider of DIAGNOSTIC_PROVIDERS) {
      const entry = diagnostics.ai?.[provider];
      if (!entry) continue;
      if (!entry.open) {
        lines.push(`${provider}: 탭 없음`);
        continue;
      }
      if (entry.reachable === false) {
        lines.push(`${provider}: 탭 열림 · 응답 없음 (페이지 새로고침 필요)`);
        continue;
      }
      if (entry.error) {
        lines.push(`${provider}: ${entry.error}`);
        continue;
      }
      lines.push(`${provider}: 입력창 ${mark(entry.promptEditor?.found)} · 전송 ${mark(entry.sendButton?.found)} · 응답영역 ${mark(entry.responseArea?.found)}`);
    }

    const editor = diagnostics.editor;
    if (editor) {
      if (!editor.open) lines.push(`글쓰기 탭: ${editor.note || "연결 없음"}`);
      else if (editor.error) lines.push(`글쓰기 탭: ${editor.error}`);
      else {
        lines.push(`글쓰기(${editor.kind}): 제목 ${mark(editor.status?.title_area?.found)} · 본문 ${mark(editor.status?.body_area?.found)} · 이미지 ${mark(editor.status?.image_area?.found)}`);
        lines.push(`  · 문서 내 문단 ${editor.counts?.paragraphs ?? 0}개 / 이미지 ${editor.counts?.images ?? 0}개${editor.inIframe ? " · iframe 내부" : ""}`);
      }
    }
    setStatus("diagnosticsStatus", lines.join("\n"));
  }

  async function copyDiagnostics() {
    if (!STATE.diagnostics) {
      setStatus("diagnosticsStatus", "먼저 진단을 실행하세요.");
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(STATE.diagnostics, null, 2));
      appendLog("success", "진단 JSON을 클립보드에 복사했습니다.");
    } catch (error) {
      reportError("diagnosticsStatus", error);
    }
  }

  async function clearLog() {
    try {
      await sendMessage("NB_CLEAR_DEBUG_LOG");
    } catch { /* the visible log is still cleared */ }
    const consoleNode = $("realtimeLogConsole");
    if (consoleNode) consoleNode.textContent = "";
    appendLog("info", "로그를 초기화했습니다.");
  }

  /* ------------------------------------------------------------------ wiring -- */

  function wireEvents() {
    for (const id of ["bindTabButton", "bindTabNearInsertButton"]) {
      $(id)?.addEventListener("click", bindActiveTab);
    }
    $("postingModeInput")?.addEventListener("change", () => {
      applyModeVisibility();
      persistSettings();
    });
    for (const id of [
      "draftModeInput", "toneInput", "lengthInput", "articleTypeInput", "formatPresetInput",
      "textProviderInput", "imageProviderInput", "chatSessionModeInput", "autoImageRatioInput",
      "autoImageStyleInput", "instagramPostFormat", "instagramImageCount", "instagramProvider",
      "instagramImageProvider", "threadsPostFormat", "threadsPostCount", "threadsCount",
      "threadsProvider", "threadsImageProvider", "naverSearchReferenceCountInput",
    ]) {
      $(id)?.addEventListener("change", () => {
        applyDraftModeFields();
        updateCustomLengthVisibility();
        updateImageCountHint();
        persistSettings();
      });
    }
    $("draftModeInput")?.addEventListener("change", applyDraftModeFields);
    $("lengthInput")?.addEventListener("change", updateCustomLengthVisibility);
    $("autoImageCountInput")?.addEventListener("change", () => {
      updateImageCountHint();
      persistSettings();
    });
    $("templateAccentColorInput")?.addEventListener("input", () => {
      STATE.accentColor = value("templateAccentColorInput");
      renderDraft();
      persistSettings();
    });
    $("resetTemplateColorButton")?.addEventListener("click", () => {
      const preset = value("formatPresetInput");
      const theme = DraftFormat.getTheme(preset, "");
      setValue("templateAccentColorInput", theme.accent);
      STATE.accentColor = theme.accent;
      renderDraft();
      persistSettings();
    });
    for (const id of [
      "topicInput", "audienceInput", "keywordsInput", "draftRequirementsInput", "customLengthInput",
      "autoImageRequirementsInput", "instagramTopic", "instagramImageStyle", "threadsTopic",
      "threadsImageStyle", "feedbackInput", "instagramCaption",
    ]) {
      $(id)?.addEventListener("input", () => {
        if (id === "instagramCaption") updateInstagramCount();
        persistSettings();
      });
    }

    $("draftButton")?.addEventListener("click", executeDraftRequest);
    $("reviseDraftButton")?.addEventListener("click", reviseDraft);
    $("copyHtmlButton")?.addEventListener("click", copyHtml);
    $("clearResultsButton")?.addEventListener("click", clearResults);
    $("autoImageButton")?.addEventListener("click", autoImages);
    $("stopImageButton")?.addEventListener("click", stopImageGeneration);
    $("clearImagesButton")?.addEventListener("click", () => {
      STATE.images = [];
      renderImages();
      persistDraft();
    });
    $("insertButton")?.addEventListener("click", insertBlogPost);

    $("instagramGenerateCaption")?.addEventListener("click", generateInstagramCaption);
    $("instagramGenerateImages")?.addEventListener("click", generateInstagramImages);
    $("instagramGenerateAndInsert")?.addEventListener("click", async () => {
      await generateInstagramImages();
      if (STATE.instagram.images.length) await insertInstagramPost();
    });
    $("instagramImageCount")?.addEventListener("change", () => {
      updateInstagramCount();
      persistSettings();
    });

    $("threadsGenerate")?.addEventListener("click", generateThreadsContent);
    $("threadsGenerateImages")?.addEventListener("click", generateThreadsImages);
    $("threadsGenerateAndInsert")?.addEventListener("click", async () => {
      if (!STATE.threads.posts.length) await generateThreadsContent();
      if (!STATE.threads.images.length && Number(value("threadsCount")) > 0) await generateThreadsImages();
      if (STATE.threads.posts.length) await insertThreadsPost();
    });

    $("toggleQuickGuideButton")?.addEventListener("click", () => openModal("quickGuideModal"));
    $("modalCloseQuickGuideBtn")?.addEventListener("click", () => closeModal("quickGuideModal"));
    $("modalConfirmQuickGuideBtn")?.addEventListener("click", () => closeModal("quickGuideModal"));
    $("modalOpenGuideBtn")?.addEventListener("click", () => {
      closeModal("firstUseNoticeModal");
      openModal("quickGuideModal");
    });
    $("modalCloseFirstUseBtn")?.addEventListener("click", () => markFirstUseSeen());
    $("modalConfirmFirstUseBtn")?.addEventListener("click", () => markFirstUseSeen());

    $("extensionVersion")?.setAttribute("title", "딸깍 SNS");
    $("modalClose")?.addEventListener("click", () => closeModal("imageModal"));
    $("imageModal")?.addEventListener("click", (event) => {
      if (event.target === $("imageModal")) closeModal("imageModal");
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeModal("imageModal");
        closeModal("quickGuideModal");
      }
    });

    $("exportInputsButton")?.addEventListener("click", exportSettings);
    $("importInputsButton")?.addEventListener("click", () => $("importInputsFileInput")?.click());
    $("importInputsFileInput")?.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (file) await importSettings(file);
      event.target.value = "";
    });
    $("copyDebugLogButton")?.addEventListener("click", copyLog);
    $("clearDebugLogButton")?.addEventListener("click", clearLog);
    $("photoFiles")?.addEventListener("change", async (event) => {
      await addPhotoFiles(event.target.files);
      event.target.value = "";
    });
    $("photoUsageMode")?.addEventListener("change", () => {
      applyModeVisibility();
      persistSettings();
    });
    for (const id of ["photoTopicInput", "photoContentInput", "photoGuideInput", "photoToneInput", "photoProviderInput", "photoUsageCountInput"]) {
      $(id)?.addEventListener("input", () => persistSettings());
      $(id)?.addEventListener("change", () => persistSettings());
    }
    $("photoGenerateButton")?.addEventListener("click", generatePhotoArticle);
    $("photoInsertButton")?.addEventListener("click", insertPhotoArticle);

    $("refreshAccessButton")?.addEventListener("click", refreshAccess);
    $("toggleLicenseFormButton")?.addEventListener("click", () => {
      $("licenseForm")?.classList.toggle("hidden");
      if (!$("licenseForm")?.classList.contains("hidden")) $("licenseKeyInput")?.focus();
    });
    $("verifyLicenseButton")?.addEventListener("click", verifyLicense);
    $("licenseKeyInput")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void verifyLicense();
      }
    });
    $("clearLicenseButton")?.addEventListener("click", clearLicense);
    $("saveEndpointButton")?.addEventListener("click", saveAccessEndpoint);
    $("openRewardButton")?.addEventListener("click", openReward);
    $("claimRewardButton")?.addEventListener("click", claimReward);
    $("verifyMembershipButton")?.addEventListener("click", verifyMembership);

    $("runDiagnosticsButton")?.addEventListener("click", runDiagnostics);
    $("copyDiagnosticsButton")?.addEventListener("click", copyDiagnostics);

    $("uiLanguage")?.addEventListener("change", () => {
      STATE.language = value("uiLanguage");
      Language.applyLanguage(STATE.language);
      persistSettings({ immediate: true });
    });
  }

  function markFirstUseSeen() {
    chrome.storage.local.set({ [FIRST_USE_KEY]: true }).catch(() => {});
    closeModal("firstUseNoticeModal");
  }

  function applyDraftModeFields() {
    const search = value("draftModeInput") === "naver-search";
    $("manualDraftFields")?.classList.toggle("hidden", search);
    $("naverSearchResearchFields")?.classList.toggle("hidden", !search);
  }

  let initialized = false;

  async function init() {
    if (initialized) return;
    initialized = true;
    try {
      const manifest = chrome.runtime.getManifest();
      const versionNode = $("extensionVersion");
      if (versionNode) versionNode.textContent = `v${manifest.version}`;
    } catch { /* ignore */ }

    wireEvents();
    await loadSettings();
    applyDraftModeFields();
    renderInstagramPrompts();
    renderThreadsPosts();
    renderThreadsPrompts();
    updateInstagramCount();
    await refreshContext();
    await refreshAccess();
    appendLog("info", "로그인된 AI 화면을 사용합니다. 게시 버튼은 항상 직접 눌러 주세요.");
  }

  document.addEventListener("DOMContentLoaded", () => void init());
  if (document.readyState !== "loading") void init();
})();
