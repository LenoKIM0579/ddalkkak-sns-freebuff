/**
 * Final View Controller for Gemini AI Blog Writer
 * Provides responsive PC/Mobile preview, HTML copying, file download, and inline editing.
 */

let currentArticle = null;
let isEditMode = false;

document.addEventListener("DOMContentLoaded", async () => {
  collectElements();
  bindEvents();
  await loadArticle();
});

const elements = {};

function collectElements() {
  elements.toolbarTitle = document.getElementById("toolbarTitle");
  elements.toolbarBadge = document.getElementById("toolbarBadge");
  elements.btnDesktopView = document.getElementById("btnDesktopView");
  elements.btnMobileView = document.getElementById("btnMobileView");
  elements.btnOpenRevisionModal = document.getElementById("btnOpenRevisionModal");
  elements.btnToggleEdit = document.getElementById("btnToggleEdit");
  elements.btnViewSource = document.getElementById("btnViewSource");
  elements.btnCopyHtml = document.getElementById("btnCopyHtml");
  elements.btnDownloadHtml = document.getElementById("btnDownloadHtml");

  elements.articleContainer = document.getElementById("articleContainer");
  elements.articleTags = document.getElementById("articleTags");
  elements.articleTitle = document.getElementById("articleTitle");
  elements.articleDate = document.getElementById("articleDate");
  elements.articleImageCount = document.getElementById("articleImageCount");
  elements.articleSummaryCard = document.getElementById("articleSummaryCard");
  elements.articleSummaryText = document.getElementById("articleSummaryText");
  elements.articleContent = document.getElementById("articleContent");

  elements.sourceModal = document.getElementById("sourceModal");
  elements.rawSourceTextarea = document.getElementById("rawSourceTextarea");
  elements.btnCloseModal = document.getElementById("btnCloseModal");
  elements.btnCloseModalBottom = document.getElementById("btnCloseModalBottom");
  elements.btnCopySourceModal = document.getElementById("btnCopySourceModal");

  // AI 추가 수정 모달 및 오버레이
  elements.revisionModal = document.getElementById("revisionModal");
  elements.viewRevisionInput = document.getElementById("viewRevisionInput");
  elements.btnSubmitViewRevision = document.getElementById("btnSubmitViewRevision");
  elements.btnCloseRevisionModal = document.getElementById("btnCloseRevisionModal");
  elements.btnCloseRevisionModalBottom = document.getElementById("btnCloseRevisionModalBottom");
  elements.revisionLoadingOverlay = document.getElementById("revisionLoadingOverlay");

  elements.toast = document.getElementById("toast");
}

function bindEvents() {
  elements.btnDesktopView.addEventListener("click", () => setViewMode("desktop"));
  elements.btnMobileView.addEventListener("click", () => setViewMode("mobile"));
  elements.btnToggleEdit.addEventListener("click", toggleEditMode);
  elements.btnViewSource.addEventListener("click", openSourceModal);
  elements.btnCopyHtml.addEventListener("click", copyCurrentHtml);
  elements.btnDownloadHtml.addEventListener("click", downloadHtmlFile);

  elements.btnCloseModal.addEventListener("click", closeSourceModal);
  elements.btnCloseModalBottom.addEventListener("click", closeSourceModal);
  elements.btnCopySourceModal.addEventListener("click", copySourceFromModal);

  elements.sourceModal.addEventListener("click", (e) => {
    if (e.target === elements.sourceModal) closeSourceModal();
  });

  // AI 추가 수정 모달 이벤트
  if (elements.btnOpenRevisionModal) {
    elements.btnOpenRevisionModal.addEventListener("click", openRevisionModal);
  }
  if (elements.btnCloseRevisionModal) {
    elements.btnCloseRevisionModal.addEventListener("click", closeRevisionModal);
  }
  if (elements.btnCloseRevisionModalBottom) {
    elements.btnCloseRevisionModalBottom.addEventListener("click", closeRevisionModal);
  }
  if (elements.btnSubmitViewRevision) {
    elements.btnSubmitViewRevision.addEventListener("click", handleExecuteViewRevision);
  }
  if (elements.revisionModal) {
    elements.revisionModal.addEventListener("click", (e) => {
      if (e.target === elements.revisionModal) closeRevisionModal();
    });

    // 퀵 칩 클릭 이벤트
    elements.revisionModal.querySelectorAll(".quick-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const text = chip.getAttribute("data-chip");
        if (!text || !elements.viewRevisionInput) return;
        if (elements.viewRevisionInput.value.trim()) {
          elements.viewRevisionInput.value = elements.viewRevisionInput.value.trim() + " " + text;
        } else {
          elements.viewRevisionInput.value = text;
        }
        elements.viewRevisionInput.focus();
      });
    });
  }

  // 백그라운드 및 사이드패널과의 실시간 업데이트 동기화
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "GB_ARTICLE_UPDATED") {
      loadArticle();
      showToast(`🔄 포스팅이 새로운 버전(v${message.version || ""})으로 자동 갱신되었습니다.`);
    }
  });
}

async function loadArticle() {
  try {
    // 1. IndexedDB에서 대용량 아티클 직접 조회 (64MiB 제한 없음)
    let article = await getArticleFromDB().catch((err) => {
      console.warn("[FinalView] IndexedDB read warning:", err);
      return null;
    });

    // 2. 만약 IndexedDB에 없으면 chrome.storage.local 폴백
    if (!article) {
      const stored = await chrome.storage.local.get("GB_CURRENT_FINAL_ARTICLE").catch(() => ({}));
      article = stored?.GB_CURRENT_FINAL_ARTICLE;
    }

    if (!article) {
      elements.articleTitle.textContent = "작성된 블로그 글이 없습니다.";
      elements.articleContent.innerHTML = "<p>사이드패널에서 먼저 포스팅 작성을 진행해 주세요.</p>";
      return;
    }

    currentArticle = article;
    if (currentArticle && currentArticle.html) {
      currentArticle.html = stripLeadingCodeblockHeaders(currentArticle.html);
    }
    renderArticle(currentArticle);
  } catch (err) {
    console.error("Failed to load article:", err);
    elements.articleTitle.textContent = "글을 불러오는 중 오류가 발생했습니다.";
  }
}

function renderArticle(article) {
  const uiText = text => window.ddalkkakUiText?.(text) || text;
  document.title = `${article.title || uiText("블로그 포스팅")} - ${uiText("딸깍 SNS")}`;
  elements.toolbarTitle.textContent = article.title || uiText("블로그 포스팅");
  elements.articleTitle.textContent = article.title || uiText("제목 없음");

  const ver = article.version || 1;
  if (elements.toolbarBadge) {
    elements.toolbarBadge.textContent = ver === 1 ? "최종 완성본 (v1)" : `수정본 (v${ver})`;
  }

  // 날짜 및 메타
  const dateObj = article.createdAt ? new Date(article.createdAt) : new Date();
  const dateStr = `${dateObj.getFullYear()}.${String(dateObj.getMonth() + 1).padStart(2, "0")}.${String(dateObj.getDate()).padStart(2, "0")}`;
  elements.articleDate.textContent = dateStr;

  const totalImgCount = Array.isArray(article.images) ? article.images.length : 0;
  const insertedCount = (article.html ? (article.html.match(/<figure[^>]*class="[^"]*post-image-card[^"]*"[^>]*>/gi) || []).length : 0) || article.usedImageCount || totalImgCount;
  if (article.imageUsageMode === "custom" && insertedCount < totalImgCount) {
    elements.articleImageCount.textContent = `이미지 ${insertedCount}장 선별 포함 (총 ${totalImgCount}장 중)`;
  } else {
    elements.articleImageCount.textContent = `이미지 ${insertedCount}장 포함`;
  }

  // 태그
  elements.articleTags.innerHTML = "";
  (article.tags || []).forEach((tag) => {
    const tagEl = document.createElement("span");
    tagEl.className = "article-tag";
    tagEl.textContent = `#${tag.replace(/^#/, "")}`;
    elements.articleTags.appendChild(tagEl);
  });

  // 요약
  if (article.summary) {
    elements.articleSummaryCard.style.display = "flex";
    elements.articleSummaryText.textContent = article.summary;
  } else {
    elements.articleSummaryCard.style.display = "none";
  }

  // 본문 (이미지가 이미 결합된 HTML)
  const cleanHtml = PhotoWriter.sanitize(stripLeadingCodeblockHeaders(article.html || ""));
  elements.articleContent.innerHTML = cleanHtml || `<p>${uiText("내용이 없습니다.")}</p>`;
}

function setViewMode(mode) {
  if (mode === "mobile") {
    elements.articleContainer.classList.remove("desktop-mode");
    elements.articleContainer.classList.add("mobile-mode");
    elements.btnMobileView.classList.add("active");
    elements.btnDesktopView.classList.remove("active");
    showToast("📱 모바일 화면 비율로 전환되었습니다.");
  } else {
    elements.articleContainer.classList.remove("mobile-mode");
    elements.articleContainer.classList.add("desktop-mode");
    elements.btnDesktopView.classList.add("active");
    elements.btnMobileView.classList.remove("active");
    showToast("💻 PC 와이드 화면으로 전환되었습니다.");
  }
}

function toggleEditMode() {
  isEditMode = !isEditMode;
  elements.articleContent.contentEditable = isEditMode ? "true" : "false";
  elements.btnToggleEdit.classList.toggle("active-edit", isEditMode);

  if (isEditMode) {
    elements.btnToggleEdit.innerHTML = "💾 편집 완료";
    showToast("✏️ 실시간 편집 모드: 본문을 클릭하여 자유롭게 수정하세요.");
  } else {
    elements.btnToggleEdit.innerHTML = "✏️ 직접 수정";
    // 수정한 내용을 저장
    if (currentArticle) {
      currentArticle.html = PhotoWriter.sanitize(elements.articleContent.innerHTML);
      saveArticleToDB(currentArticle).catch(() => {});
      chrome.storage.local.set({ GB_CURRENT_FINAL_ARTICLE: currentArticle }).catch(() => {});
    }
    showToast("✅ 수정 내용이 저장되었습니다.");
  }
}

async function copyCurrentHtml() {
  const htmlToCopy = elements.articleContent.innerHTML;
  try {
    await navigator.clipboard.writeText(htmlToCopy);
    showToast("📋 완성된 HTML 코드가 복사되었습니다! 블로그 에디터에 바로 붙여넣으세요.");
  } catch (e) {
    showToast("복사 실패: " + e.message);
  }
}

function downloadHtmlFile() {
  if (!currentArticle) return;

  const fullHtmlDocument = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(currentArticle.title || "블로그 포스팅")}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Apple SD Gothic Neo", sans-serif;
      line-height: 1.8;
      color: #1e293b;
      background: #f8fafc;
      padding: 40px 20px;
      margin: 0;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      background: #ffffff;
      padding: 48px;
      border-radius: 16px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.06);
    }
    h1 { font-size: 28px; font-weight: 800; color: #0f172a; margin-bottom: 24px; line-height: 1.35; }
    h2 { font-size: 22px; font-weight: 800; color: #0f172a; margin: 36px 0 16px; padding-bottom: 8px; border-bottom: 2px solid #e2e8f0; }
    h3 { font-size: 18px; font-weight: 700; color: #1e293b; margin: 28px 0 12px; }
    p { margin-bottom: 18px; }
    ul, ol { margin: 16px 0 20px 24px; }
    li { margin-bottom: 8px; }
    blockquote { background: #f8fafc; border-left: 4px solid #7c3aed; padding: 14px 18px; margin: 24px 0; border-radius: 0 10px 10px 0; }
    figure { margin: 32px 0; text-align: center; }
    figure img { max-width: 100%; height: auto; border-radius: 12px; box-shadow: 0 4px 14px rgba(0,0,0,0.08); }
    figcaption { margin-top: 10px; font-size: 13px; color: #64748b; }
    .tags { display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; }
    .tag { background: #f1f5f9; color: #2563eb; font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="tags">
      ${(currentArticle.tags || []).map((t) => `<span class="tag">#${escapeHtml(t.replace(/^#/, ""))}</span>`).join("")}
    </div>
    <h1>${escapeHtml(currentArticle.title || "")}</h1>
    <div class="content">
      ${elements.articleContent.innerHTML}
    </div>
  </div>
</body>
</html>`;

  const blob = new Blob([fullHtmlDocument], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const fileName = sanitizeFileName(currentArticle.title || "blog_post") + ".html";
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast(`💾 "${fileName}" 파일이 다운로드되었습니다.`);
}

function openSourceModal() {
  elements.rawSourceTextarea.value = elements.articleContent.innerHTML;
  elements.sourceModal.classList.add("open");
}

function closeSourceModal() {
  elements.sourceModal.classList.remove("open");
}

async function copySourceFromModal() {
  try {
    await navigator.clipboard.writeText(elements.rawSourceTextarea.value);
    showToast("📋 소스코드가 복사되었습니다.");
  } catch (e) {
    showToast("복사 실패: " + e.message);
  }
}

let toastTimer = null;
function showToast(msg) {
  clearTimeout(toastTimer);
  elements.toast.textContent = msg;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => {
    elements.toast.classList.remove("show");
  }, 2500);
}

function sanitizeFileName(name) {
  return String(name || "blog_post")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "_")
    .slice(0, 50);
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ==========================================
// IndexedDB 대용량 스토리지 관리자 (64MiB 제한 우회)
// ==========================================

const DB_NAME = "DdalkkakPhotoWriterDB";
const STORE_NAME = "articles";
const DB_VERSION = 1;

function openArticleDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

async function getArticleFromDB() {
  const db = await openArticleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get("current_article");
    getReq.onsuccess = () => resolve(getReq.result || null);
    getReq.onerror = (e) => reject(e.target.error);
  });
}

async function saveArticleToDB(article) {
  const db = await openArticleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const putReq = store.put(article, "current_article");
    putReq.onsuccess = () => resolve(true);
    putReq.onerror = (e) => reject(e.target.error);
  });
}

async function getImagesFromDB() {
  const db = await openArticleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get("current_images");
    getReq.onsuccess = () => resolve(getReq.result || []);
    getReq.onerror = (e) => reject(e.target.error);
  });
}

async function saveImagesToDB(images) {
  const db = await openArticleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const putReq = store.put(images, "current_images");
    putReq.onsuccess = () => resolve(true);
    putReq.onerror = (e) => reject(e.target.error);
  });
}

// ==========================================
// AI 추가 요청 반영 (재제작) 컨트롤러
// ==========================================

function openRevisionModal() {
  if (!currentArticle) {
    alert("수정할 블로그 글이 없습니다.");
    return;
  }
  elements.viewRevisionInput.value = "";
  elements.revisionModal.classList.add("open");
  elements.viewRevisionInput.focus();
}

function closeRevisionModal() {
  elements.revisionModal.classList.remove("open");
}

async function handleExecuteViewRevision() {
  const revisionPrompt = elements.viewRevisionInput.value.trim();
  if (!revisionPrompt) {
    alert("반영할 추가 요청사항이나 수정 피드백을 입력해 주세요.\n(예: 소제목 2번에 배터리 타임 보강, 더 친근한 문체로 변경 등)");
    elements.viewRevisionInput.focus();
    return;
  }

  if (!currentArticle) {
    alert("현재 로드된 블로그 글이 없습니다.");
    return;
  }

  elements.revisionLoadingOverlay.style.display = "flex";

  try {
    let cachedImages = await getImagesFromDB();
    if (!Array.isArray(cachedImages) || cachedImages.length === 0) {
      // Fallback: DOM에서 이미지 추출
      const imgs = elements.articleContent.querySelectorAll("figure.post-image-card img, img");
      cachedImages = Array.from(imgs).map((img, idx) => ({
        id: `img_${idx}`,
        name: `사진_${idx + 1}`,
        dataUrl: img.src,
        label: img.alt || `사진 ${idx + 1}`,
        visionDescription: "",
      }));
    }

    const currentVer = currentArticle.version || 1;
    const nextVer = currentVer + 1;

    const prompt = buildArticleRevisionPrompt({
      topic: currentArticle.topic || currentArticle.title,
      content: currentArticle.content || "",
      tone: "friendly",
      guide: "",
      images: cachedImages,
      previousArticle: currentArticle,
      revisionPrompt,
      imageUsageMode: currentArticle.imageUsageMode || "all",
      customImageCount: currentArticle.customImageCount || 5,
    });

    const result = await chrome.runtime.sendMessage({
      type: "GB_SUBMIT_GEMINI",
      prompt,
      options: {
        isNewSession: true,
        newChat: false,
        timeoutMs: 240000,
      },
    });

    if (!result?.ok || !result.text) {
      throw new Error(result?.error || "Gemini로부터 수정 응답을 받지 못했습니다.");
    }

    const parsed = parseArticleResponse(result.text, currentArticle.title);
    const assembledHtml = assembleHtmlWithUserImages(parsed.html, cachedImages, {
      imageUsageMode: currentArticle.imageUsageMode || "all",
      customImageCount: currentArticle.customImageCount || 5,
    });

    const usedCount = (assembledHtml.match(/<figure[^>]*class="[^"]*post-image-card[^"]*"[^>]*>/gi) || []).length;
    const prevHistory = Array.isArray(currentArticle.revisionHistory) ? currentArticle.revisionHistory : [];

    currentArticle = {
      ...currentArticle,
      title: parsed.title || currentArticle.title,
      summary: parsed.summary || currentArticle.summary,
      html: assembledHtml,
      rawDraftHtml: parsed.html,
      tags: (parsed.tags && parsed.tags.length > 0) ? parsed.tags : (currentArticle.tags || []),
      usedImageCount: usedCount,
      version: nextVer,
      revisionPrompt,
      revisionHistory: [
        ...prevHistory,
        {
          version: nextVer,
          prompt: revisionPrompt,
          timestamp: Date.now(),
        },
      ],
    };

    await saveArticleToDB(currentArticle);

    // 사이드패널 및 기타 창에 실시간 동기화 알림 브로드캐스트
    chrome.runtime.sendMessage({ type: "GB_ARTICLE_UPDATED", version: nextVer }).catch(() => {});
    await chrome.runtime.sendMessage({ type: "GB_CLOSE_GEMINI" }).catch(() => {});

    closeRevisionModal();
    renderArticle(currentArticle);
    showToast(`✨ 추가 요청사항이 반영된 새 버전(v${nextVer})으로 업데이트되었습니다!`);
  } catch (err) {
    console.error("[FinalView] Revision error:", err);
    alert("수정 재제작 중 오류가 발생했습니다: " + (err.message || String(err)));
  } finally {
    elements.revisionLoadingOverlay.style.display = "none";
  }
}

function buildArticleRevisionPrompt({ topic, content, tone, guide, images, previousArticle, revisionPrompt, imageUsageMode = "all", customImageCount = 5 }) {
  const toneDescriptions = {
    friendly: "친근하고 편안하며 소통하는 해요체 (~해요, ~했답니다, ~해보세요)",
    professional: "전문적이고 신뢰감을 주는 정중하고 명확한 어조 (~합니다, ~되었습니다)",
    witty: "위트 있고 경쾌하며 유머러스하고 몰입감 있는 매력적인 어조 (~했더랬죠, ~대박이에요)",
    informative: "정보 전달에 집중한 간결하고 객관적인 설명 어조 (~입니다, ~에 해당합니다)",
    emotional: "감성적이고 일상 에세이처럼 따뜻하고 서정적인 어조 (~했던 하루, ~가 남네요)",
  };

  const safeImages = Array.isArray(images) ? images : [];
  const isCustomMode = imageUsageMode === "custom" && safeImages.length > 0 && customImageCount < safeImages.length;
  const targetImageCount = isCustomMode ? Math.max(1, Math.min(customImageCount, safeImages.length)) : safeImages.length;

  let imageCatalog = "";
  if (safeImages.length > 0) {
    if (isCustomMode) {
      imageCatalog = `[활용 가능한 사진 목록 (총 ${safeImages.length}장 중 ${targetImageCount}장 엄선 배치 지침)]
사용자가 전체 ${safeImages.length}장의 사진 중 가장 중요한 딱 ${targetImageCount}장만 선별하여 배치하기를 원합니다:
${safeImages
  .map((img, idx) => {
    const label = img.label ? ` (사용자 메모: ${img.label})` : "";
    const vision = img.visionDescription ? ` / 분석: ${img.visionDescription}` : "";
    return `  - [사진 #${idx}]: ${img.name}${label}${vision}`;
  })
  .join("\n")}
* 지침: 위 사진 중 가장 어울리는 ${targetImageCount}개만 골라 <!-- USER_IMAGE_선택된번호 --> 주석으로 본문에 배치하세요. (정확히 ${targetImageCount}개의 주석만 본문에 포함할 것)`;
    } else {
      imageCatalog = `[활용 가능한 사진 목록 및 시각적 특징 (총 ${safeImages.length}장)]
본문 작성 시 문맥에 맞는 최적의 위치에 <!-- USER_IMAGE_X --> 주석 형태로 사진을 배치하세요.
${safeImages
  .map((img, idx) => {
    const label = img.label ? ` (사용자 메모: ${img.label})` : "";
    const vision = img.visionDescription
      ? `\n   - 시각적 분석: ${img.visionDescription}`
      : "\n   - 시각적 분석: 본문 문맥에 맞게 배치";
    return `[사진 #${idx}] 파일명: ${img.name}${label}${vision} -> 삽입 주석: <!-- USER_IMAGE_${idx} -->`;
  })
  .join("\n")}`;
    }
  }

  return `당신은 대한민국 최고의 파워블로거이자 전문 콘텐츠 에디터입니다.
이전에 작성된 블로그 포스팅 초안을 바탕으로, **사용자의 추가 수정 및 보완 요청사항을 충실히 반영하여 글을 전문적으로 재작성(업그레이드)**해 주세요.

[기존 글 정보]
1. 주제/키워드: ${topic || previousArticle?.title || "블로그 포스팅"}
2. 원래 사용자가 입력했던 핵심 내용:
${content || "(이전 본문 초안 참조)"}
3. 톤앤매너: ${toneDescriptions[tone] || "친근하고 유익한 해요체"}
4. 기존 가이드: ${guide || "네이버 블로그 독자에게 유익하고 읽기 쉽게 작성"}

[이전 작성된 블로그 본문 초안 (수정 전)]
제목: ${previousArticle?.title || ""}
요약: ${previousArticle?.summary || ""}
본문:
${previousArticle?.rawDraftHtml || previousArticle?.html || ""}

${imageCatalog}

==================================================
[🔥 사용자의 추가 수정 및 보완 요청사항]
"${revisionPrompt}"
==================================================

[수정 및 재작성 지침]
1. ⭐ [최우선] 사용자의 추가 수정 및 보완 요청사항을 100% 충실하게 본문에 반영하세요.
2. 기존 초안의 검증된 팩트와 자연스러운 서사 구조는 존중하되, 사용자가 수정을 요청한 부분(문체 변경, 특정 소제목/문단 보강, 설명 추가/삭제, 순서 조정, 표/요약 추가 등)을 완성도 높게 업그레이드하세요.
3. 사진 배치 주석 (<!-- USER_IMAGE_X -->):
   - 본문 흐름에 맞게 <!-- USER_IMAGE_X --> 주석을 적절한 위치에 유지하거나 문맥에 맞게 자연스럽게 재배치하세요.
   - 사용자가 특정 사진의 위치나 설명 보강을 요청한 경우 반드시 반영하세요.
   ${isCustomMode ? `- 본문에는 엄선된 ${targetImageCount}개의 <!-- USER_IMAGE_X --> 주석만 포함하세요.` : ""}
4. 네이버/티스토리 블로그에 최적화되도록 2~3문장 단위의 짧은 단락(<p>), <h2>/<h3> 소제목, <strong> 강조, <ul>/<li> 목록, 필요시 <blockquote> 인용구를 적극 활용하세요.
5. 반드시 아래 예시와 같이 \`\`\`html 코드블록 안에 상단 메타데이터 주석과 수정된 본문 HTML 코드를 작성해 주세요:

[출력 형식 예시]
\`\`\`html
<!-- TITLE: 수정/보완 요청사항이 반영된 매력적인 블로그 제목 -->
<!-- SUMMARY: 글의 핵심 요약 1~2문장 -->
<!-- TAGS: 추천태그1, 추천태그2, 추천태그3, 추천태그4, 추천태그5 -->

<p style="color: #666; font-size: 0.9em; margin-bottom: 20px;">본 포스팅은 판매처로부터 소정의 원고료(또는 제품)를 제공받아 작성되었습니다.</p>

<p>수정된 문단 내용...</p>

<!-- USER_IMAGE_0 -->

<h2>1. 소제목</h2>
<p>소제목 아래 상세 본문 단락...</p>

<!-- USER_IMAGE_1 -->
\`\`\``;
}

function stripLeadingCodeblockHeaders(text) {
  let cleaned = String(text || "").trim();
  let prev = "";
  while (cleaned !== prev) {
    prev = cleaned;
    cleaned = cleaned
      // 1) 마크다운 백틱 코드블록 시작부 (```html, ```xml, ``` 등)
      .replace(/^```(?:html|xml|markdown|md|json|text)?\s*/i, "")
      // 2) 코드블록 헤더 잔여 라벨이 단독 줄에 있거나 개행으로 이어지는 경우
      //    (예: "HTML\n", "HTML\r\n", "HTML\n복사\n", "content_copy\n" 등)
      .replace(/^(?:html|xml|markdown|md|json|text|code|복사|코드\s*복사|copy(?:\s*code)?|content_copy|download)\s*(?:\r?\n+|$)/i, "")
      // 3) 태그나 주석(<p>, <!--, <div> 등) 바로 앞에 붙어있는 언어 라벨
      //    (예: "HTML <p>", "HTML <!-- TITLE", "HTML\n<p>")
      .replace(/^(?:html|xml|markdown|md|json|text|code)\s*(?=<[/!a-zA-Z])/i, "")
      // 4) <p> 태그 안에 단독으로 들어간 "HTML", "html" 등
      //    (예: "<p>HTML</p>", "<p style="...">html</p>")
      .replace(/^<p[^>]*>\s*(?:html|xml|markdown|md|json|text|code|복사|copy)\s*<\/p>\s*/i, "")
      .trim();
  }
  return cleaned;
}

function normalizeArticleHtml(rawHtml, imageCount = 0) {
  let text = String(rawHtml || "").trim();
  text = stripLeadingCodeblockHeaders(text);

  const pCount = (text.match(/<p[^>]*>/gi) || []).length;
  const hCount = (text.match(/<h[1-4][^>]*>/gi) || []).length;
  if (pCount >= 3 || hCount >= 2) {
    return stripLeadingCodeblockHeaders(text);
  }

  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  let imageCounter = 0;
  if (!text.includes("<!-- USER_IMAGE_")) {
    text = text.replace(/\n{3,}/g, () => {
      if (imageCounter < imageCount) {
        const slot = `\n\n<!-- USER_IMAGE_${imageCounter} -->\n\n`;
        imageCounter++;
        return slot;
      }
      return "\n\n";
    });
  }

  const blocks = text.split(/\n{2,}/);
  const htmlBlocks = [];

  for (let block of blocks) {
    block = block.trim();
    if (!block) continue;

    // 만약 단독 block이 "HTML", "xml", "markdown", "복사" 등이라면 스킵
    if (/^(?:html|xml|markdown|md|text|json|복사|copy)$/i.test(block)) {
      continue;
    }

    if (/^<!--\s*USER_IMAGE_\d+\s*-->$/i.test(block) || /^<[a-z]+[^>]*>/i.test(block)) {
      htmlBlocks.push(block);
      continue;
    }

    if (/^(?:#+\s*|\d+\.\s+|[0-9]+[)\.]\s*)([^\n]+)$/.test(block) && block.length < 80) {
      const headingText = block.replace(/^(?:#+\s*|\d+\.\s+|[0-9]+[)\.]\s*)/, "").trim();
      htmlBlocks.push(`<h2 style="font-size: 1.35em; font-weight: 700; color: #1e293b; margin: 36px 0 16px; border-bottom: 2px solid #3b82f6; padding-bottom: 8px;">${headingText}</h2>`);
      continue;
    }

    if (/^(?:💡|🛒|📌|TIP|주의|스펙|요약)/.test(block)) {
      const formatted = block.replace(/\n/g, "<br>");
      htmlBlocks.push(`
<blockquote style="margin: 24px 0; padding: 18px 20px; background: #f8fafc; border-left: 4px solid #3b82f6; border-radius: 8px; color: #334155; font-size: 0.95em; line-height: 1.7;">
  ${formatted}
</blockquote>`);
      continue;
    }

    const paragraph = block.replace(/\n/g, "<br>");
    htmlBlocks.push(`<p style="margin-bottom: 18px; line-height: 1.8; color: #334155; font-size: 1.05em;">${paragraph}</p>`);
  }

  return stripLeadingCodeblockHeaders(htmlBlocks.join("\n\n"));
}

function parseArticleResponse(rawText, fallbackTopic, images = []) {
  const source = String(rawText || "").trim();
  const json = parseJsonFromText(rawText);
  let html = "";
  let title = fallbackTopic || "블로그 포스팅";
  let summary = "";
  let tags = ["블로그", "포스팅", "추천"];

  if (json && (json.html || json.html_content)) {
    title = String(json.title || fallbackTopic || "추천 블로그 포스팅").trim();
    summary = String(json.summary || "").trim();
    tags = Array.isArray(json.seo_tags) ? json.seo_tags : [];
    html = stripLeadingCodeblockHeaders(String(json.html || json.html_content || "").trim());
  } else {
    const titleCommentMatch = source.match(/<!--\s*TITLE:\s*([^\n\r>]+)-->/i);
    if (titleCommentMatch && titleCommentMatch[1].trim()) {
      title = titleCommentMatch[1].trim();
    } else {
      const h1Match = source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || source.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
      if (h1Match && h1Match[1].trim()) {
        title = h1Match[1].replace(/<[^>]*>/g, "").trim();
      }
    }

    const summaryCommentMatch = source.match(/<!--\s*SUMMARY:\s*([^\n\r>]+)-->/i);
    if (summaryCommentMatch && summaryCommentMatch[1].trim()) {
      summary = summaryCommentMatch[1].trim();
    }

    const tagsCommentMatch = source.match(/<!--\s*TAGS:\s*([^\n\r>]+)-->/i);
    if (tagsCommentMatch && tagsCommentMatch[1].trim()) {
      tags = tagsCommentMatch[1].split(/[,#\s]+/).map((t) => t.trim()).filter(Boolean);
    }

    html = extractHtmlContent(rawText);
    html = html.replace(/<!--\s*(?:TITLE|SUMMARY|TAGS):[^\n\r>]*-->/gi, "").trim();
    html = stripLeadingCodeblockHeaders(html);
  }

  const imageCount = Array.isArray(images) ? images.length : 0;
  html = normalizeArticleHtml(html, imageCount);
  html = stripLeadingCodeblockHeaders(html);

  return {
    title,
    summary,
    tags,
    html,
  };
}

function assembleHtmlWithUserImages(htmlContent, images, options = {}) {
  const safeImages = Array.isArray(images) ? images.filter(Boolean) : [];
  let result = extractHtmlContent(htmlContent);
  result = stripLeadingCodeblockHeaders(result);

  const usageMode = options.imageUsageMode || "all";
  const customCount = typeof options.customImageCount === "number" ? options.customImageCount : safeImages.length;
  const targetCount = usageMode === "custom" ? Math.max(1, Math.min(customCount, safeImages.length)) : safeImages.length;

  result = normalizeArticleHtml(result, targetCount);
  result = stripLeadingCodeblockHeaders(result);

  if (!safeImages.length) {
    return result;
  }

  safeImages.forEach((img) => {
    img.__inserted = false;
  });

  const placeholderRegex =
    /(?:<p>\s*)?<!--\s*(?:USER_IMAGE|IMAGE_SLOT|ATTACHED_IMAGE|IMAGE|이미지|사진)[_:\s-]*0*([0-9]+)[\s\S]*?-->(\s*<\/p>)?|(?:<p>\s*)?\[\s*(?:USER_IMAGE|IMAGE_SLOT|ATTACHED_IMAGE|IMAGE|이미지|사진)[_:\s-]*0*([0-9]+)[\s\S]*?\](\s*<\/p>)?/gi;

  const matches = [];
  let m;
  while ((m = placeholderRegex.exec(result)) !== null) {
    const rawNum = m[1] !== undefined ? m[1] : m[3];
    matches.push({
      fullMatch: m[0],
      slotNum: parseInt(rawNum, 10),
      index: m.index,
    });
  }

  const slotNums = matches.map((item) => item.slotNum);
  const isOneBased = false; // The prompt uses zero-based USER_IMAGE_N catalog indices.
  const usedImageIndices = new Set();

  matches.forEach((match) => {
    if (usageMode === "custom" && usedImageIndices.size >= targetCount) {
      result = result.replace(match.fullMatch, "");
      return;
    }

    let targetIndex = isOneBased ? match.slotNum - 1 : match.slotNum;

    if (targetIndex < 0 || targetIndex >= safeImages.length || usedImageIndices.has(targetIndex)) {
      const fallbackIdx = safeImages.findIndex((_, i) => !usedImageIndices.has(i));
      if (fallbackIdx >= 0 && (usageMode === "all" || usedImageIndices.size < targetCount)) {
        targetIndex = fallbackIdx;
      } else {
        result = result.replace(match.fullMatch, "");
        return;
      }
    }

    const img = safeImages[targetIndex];
    result = result.replace(match.fullMatch, formatUserImageFigureHtml(img, targetIndex));
    usedImageIndices.add(targetIndex);
    img.__inserted = true;
  });

  const neededMoreCount = usageMode === "custom" ? Math.max(0, targetCount - usedImageIndices.size) : safeImages.length - usedImageIndices.size;

  if (neededMoreCount > 0) {
    const remainingImages = safeImages.filter((_, idx) => !usedImageIndices.has(idx)).slice(0, neededMoreCount);

    if (remainingImages.length > 0) {
      let insertedViaDom = false;
      try {
        if (typeof document !== "undefined" && document.createElement) {
          const template = document.createElement("template");
          template.innerHTML = result.trim();
          const fragment = template.content;

          if (fragment && fragment.querySelectorAll) {
            const headings = Array.from(fragment.querySelectorAll("h2, h3"));
            const paragraphs = Array.from(fragment.querySelectorAll("p"));

            remainingImages.forEach((img, rIdx) => {
              const figureEl = createUserImageFigureElement(img);
              const isHero = /(대표|썸네일|thumbnail|hero|메인|0|첫)/i.test(img.label || img.name || "");

              if (isHero && paragraphs.length > 0) {
                paragraphs[0].after(figureEl);
              } else if (headings.length > rIdx) {
                headings[rIdx].after(figureEl);
              } else if (paragraphs.length > 2) {
                const pIndex = Math.min((rIdx + 1) * 2, paragraphs.length - 1);
                paragraphs[pIndex].after(figureEl);
              } else {
                fragment.appendChild(figureEl);
              }

              img.__inserted = true;
            });

            if (usageMode === "all") {
              safeImages.forEach((img) => {
                if (!img.__inserted) {
                  fragment.appendChild(createUserImageFigureElement(img));
                  img.__inserted = true;
                }
              });
            }

            const div = document.createElement("div");
            div.appendChild(fragment);
            if (div.innerHTML) {
              result = div.innerHTML;
              insertedViaDom = true;
            }
          }
        }
      } catch (domErr) {
        console.warn("[Assemble] DOM append warning:", domErr);
      }

      // DOM 조작 미지원 또는 오류 발생 시 문자열 직접 결합으로 100% 안전 보장
      if (!insertedViaDom) {
        remainingImages.forEach((img, idx) => {
          result += "\n\n" + formatUserImageFigureHtml(img, idx);
          img.__inserted = true;
        });
      }
    }
  }

  return stripLeadingCodeblockHeaders(result);
}

function formatUserImageFigureHtml(img, index) {
  const captionText = img.label ? escapeHtml(img.label) : `사진 ${index + 1}`;
  return `
<figure class="post-image-card" style="margin: 32px 0; text-align: center;">
  <img src="${img.dataUrl}" alt="${captionText}" style="max-width: 100%; height: auto; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); display: inline-block;" />
  <figcaption style="margin-top: 10px; font-size: 13px; color: #64748b; text-align: center;">📷 ${captionText}</figcaption>
</figure>`;
}

function createUserImageFigureElement(img) {
  const figure = document.createElement("figure");
  figure.className = "post-image-card";
  figure.style.margin = "32px 0";
  figure.style.textAlign = "center";

  const image = document.createElement("img");
  image.src = img.dataUrl;
  image.alt = img.label ? escapeHtml(img.label) : "첨부 사진";
  image.style.maxWidth = "100%";
  image.style.height = "auto";
  image.style.borderRadius = "12px";
  image.style.boxShadow = "0 4px 16px rgba(0,0,0,0.08)";
  image.style.display = "inline-block";

  const figcaption = document.createElement("figcaption");
  figcaption.style.marginTop = "10px";
  figcaption.style.fontSize = "13px";
  figcaption.style.color = "#64748b";
  figcaption.style.textAlign = "center";
  figcaption.textContent = img.label ? `📷 ${img.label}` : (window.ddalkkakUiText?.("📷 첨부 사진") || "📷 첨부 사진");

  figure.appendChild(image);
  figure.appendChild(figcaption);
  return figure;
}

function extractHtmlContent(text) {
  let source = String(text || "").trim();

  // 만약 전체 텍스트가 JSON 문자열 형태라면, html 필드 추출 시도
  if (source.startsWith("{") && (source.includes('"html"') || source.includes('"html_content"'))) {
    const extracted = extractFieldsFromMalformedJson(source);
    if (extracted && extracted.html) {
      return stripLeadingCodeblockHeaders(extracted.html);
    }
  }

  const codeBlockMatch = source.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch && codeBlockMatch[1].trim()) {
    source = codeBlockMatch[1].trim();
  }

  // 선두의 코드블록 헤더 잔여 텍스트 제거
  source = stripLeadingCodeblockHeaders(source);

  const bodyMatch = source.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch && bodyMatch[1].trim()) {
    source = bodyMatch[1].trim();
  } else {
    source = source
      .replace(/<!DOCTYPE[^>]*>/gi, "")
      .replace(/<html[^>]*>/gi, "")
      .replace(/<\/html>/gi, "")
      .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
      .trim();
  }

  source = stripLeadingCodeblockHeaders(source);
  return source;
}

function parseJsonFromText(text) {
  const source = String(text || "").trim();
  const cleaned = source.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

  // 1차 시도: 표준 JSON 파싱
  try {
    return JSON.parse(cleaned);
  } catch {}

  // 2차 시도: 최외곽 { } 슬라이스 파싱
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(cleaned.slice(first, last + 1));
    } catch {}
  }

  // 3차 시도: 제어문자 및 줄바꿈 정리 후 파싱
  try {
    const sanitized = (first >= 0 && last > first ? cleaned.slice(first, last + 1) : cleaned)
      .replace(/[\u0000-\u001F]+/g, (match) => (match === "\n" ? "\\n" : match === "\t" ? "\\t" : ""));
    return JSON.parse(sanitized);
  } catch {}

  // 4차 시도: LLM 결함 복구 정밀 필드 추출기
  try {
    const extracted = extractFieldsFromMalformedJson(cleaned);
    if (extracted && (extracted.html || extracted.title)) {
      return extracted;
    }
  } catch (err) {
    console.warn("[JSONParser] Fallback field extraction error:", err);
  }

  return null;
}

function extractFieldsFromMalformedJson(text) {
  const source = String(text || "").trim();
  const cleaned = source.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

  // 1. Title 추출
  let title = "";
  const titleMatch =
    cleaned.match(/"title"\s*:\s*"([\s\S]*?)(?:"\s*,\s*"(?:summary|seo_tags|tags|html|html_content)")/i) ||
    cleaned.match(/"title"\s*:\s*"([^"\r\n]*)"/i);
  if (titleMatch) {
    title = titleMatch[1].replace(/\\"/g, '"').trim();
  }

  // 2. Summary 추출
  let summary = "";
  const summaryMatch =
    cleaned.match(/"summary"\s*:\s*"([\s\S]*?)(?:"\s*,\s*"(?:seo_tags|tags|html|html_content|title)")/i) ||
    cleaned.match(/"summary"\s*:\s*"([^"\r\n]*)"/i);
  if (summaryMatch) {
    summary = summaryMatch[1].replace(/\\"/g, '"').trim();
  }

  // 3. SEO Tags 추출
  let seo_tags = [];
  const tagsMatch = cleaned.match(/"(?:seo_tags|tags)"\s*:\s*\[([\s\S]*?)\]/i);
  if (tagsMatch) {
    const rawTags = tagsMatch[1];
    const tagMatches = rawTags.match(/"([^"]+)"/g);
    if (tagMatches) {
      seo_tags = tagMatches.map((t) => t.replace(/^"|"$/g, "").trim()).filter(Boolean);
    }
  }

  // 4. HTML 본문 추출
  let html = "";
  const htmlIndex = cleaned.search(/"(?:html|html_content)"\s*:\s*"/i);
  if (htmlIndex !== -1) {
    const htmlStartMatch = cleaned.slice(htmlIndex).match(/"(?:html|html_content)"\s*:\s*"/i);
    const startPos = htmlIndex + htmlStartMatch[0].length;
    let rawHtml = cleaned.slice(startPos);

    rawHtml = rawHtml.replace(/"\s*}\s*$/g, "").replace(/}\s*$/g, "").trim();

    html = rawHtml
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "");
  }

  if (!title && !html) return null;

  return {
    title,
    summary,
    seo_tags,
    html,
  };
}
