// Prompt builders. Every prompt asks the model for a single JSON object so the
// panel never has to parse prose. Language of instructions is Korean; the
// requested output language is passed explicitly.
(() => {
  const TONE_LABELS = { friendly: "친근한 정보형", expert: "전문가형", review: "후기형", story: "스토리형" };
  const LENGTH_LABELS = { short: "1,000자 내외", medium: "1,800자 내외", long: "3,000자 내외" };
  const ARTICLE_LABELS = {
    auto: "주제에 맞게 자동 선택",
    information: "정보 정리형",
    review: "사용 후기형",
    comparison: "비교 분석형",
    howto: "단계별 사용법형",
    place: "장소·방문 리뷰형",
    story: "경험 스토리형",
    checklist: "체크리스트형",
  };

  function outputLanguageLine(language) {
    const value = String(language || "ko").toLowerCase();
    if (value.startsWith("en")) return "- 본문과 제목, 태그를 영어로 작성합니다.";
    if (value.startsWith("ja")) return "- 본문과 제목, 태그를 일본어로 작성합니다.";
    if (value.startsWith("es")) return "- 본문과 제목, 태그를 스페인어로 작성합니다.";
    return "- 본문과 제목을 자연스러운 한국어로 작성합니다.";
  }

  const BLOCK_RULES = `- 본문은 HTML 문자열이 아니라 블록 객체 배열(content)로 작성합니다.
- 사용할 수 있는 블록 type: paragraph, heading(level 2 또는 3), blockquote, list, ordered-list, checklist, callout, steps, pros_cons, comparison, faq, cta.
- list 계열은 items 배열을 사용하고, 상위 항목과 하위 설명은 {"text":"상위","children":["하위"]} 형태로 중첩합니다.
- comparison은 headers 배열과 rows 배열을 사용하고, faq는 items 배열에 {"question":"...","answer":"..."}를 넣습니다.
- pros_cons는 pros 배열과 cons 배열을 사용합니다. callout은 variant, title, text를 사용합니다.
- 한 paragraph 블록은 2~3개의 짧은 문장으로 유지합니다. 모바일 가독성이 최우선입니다.
- 나열 정보(사양, 특징, 장단점, 추천 대상)는 줄글 대신 list를 적극적으로 사용합니다.
- 인라인 강조는 다음 문법만 사용합니다: **굵게**, [텍스트](color:#ff3300), [텍스트](bg:yellow).
- 사실로 단정하기 어려운 내용은 보수적으로 표현하고, 확인이 필요한 부분은 review_questions에 적습니다.
- 반드시 JSON.parse 가능한 JSON만 출력하고 코드블록 표시나 설명 문장을 붙이지 않습니다.`;

  const DRAFT_SHAPE = `{
  "title": "제목",
  "summary": "핵심 요약 1~2문장",
  "content": [
    { "type": "paragraph", "text": "도입부 문단" },
    { "type": "heading", "level": 2, "text": "1. 첫 번째 소제목" },
    { "type": "paragraph", "text": "본문 단락" },
    { "type": "blockquote", "text": "강조 문구" },
    { "type": "list", "items": ["항목 1", "항목 2"] }
  ],
  "seo_tags": ["태그1", "태그2", "태그3"],
  "image_prompts": [
    { "slot": "대표 이미지", "prompt": "이미지 생성 프롬프트", "alt": "대체 텍스트", "placement_hint": "도입부 뒤", "heading_hint": "" }
  ],
  "review_questions": ["독자에게 확인하면 좋은 질문"]
}`;

  function formatResearch(research, limit = 25000) {
    const references = Array.isArray(research?.references) ? research.references.slice(0, 8) : [];
    if (!references.length) return "";
    let budget = limit;
    const blocks = [];
    references.forEach((entry, index) => {
      const title = `[${index + 1}] 제목: ${String(entry.title || "제목 없음").trim()}`;
      const snippet = `   요약: ${String(entry.snippet || "").trim() || "없음"}`;
      const url = `   링크: ${String(entry.url || "").trim() || "없음"}`;
      const body = String(entry.content || "").trim();
      let block = `${title}\n${snippet}\n${url}`;
      if (body) {
        const room = budget - block.length - 40;
        block += room > 200
          ? `\n   본문:\n${body.slice(0, room)}`
          : `\n   본문: 생략(길이 제한)`;
      }
      budget -= block.length + 2;
      if (budget <= 0) return;
      blocks.push(block);
    });
    return blocks.join("\n\n");
  }

  function buildBlogDraftPrompt(state = {}, research = null) {
    const topic = String(state.topic || research?.keyword || "").trim();
    const researchMode = Boolean(research);
    const referenceBlock = research
      ? `\n\n[검색 상위 노출 참고 데이터]\n검색 키워드: ${research.keyword || topic}\n참고 글:\n${formatResearch(research)}`
      : "";
    const researchRules = research
      ? `\n- 참고 글의 검색 의도, 제목 패턴, 비교 포인트를 분석하되 문장을 그대로 옮기지 않습니다.\n- 상위 글에 없는 정보와 차별 포인트를 보완합니다.\n- 검색 직후 알고 싶은 핵심 답변을 도입부 초반에 먼저 제시합니다.`
      : "";
    const customLength = Number(state.customLength) >= 500
      ? `${state.customLength}자 ±10%`
      : LENGTH_LABELS[state.length] || LENGTH_LABELS.medium;
    return `당신은 네이버 블로그 전문 에디터입니다. 아래 조건으로 바로 붙여넣을 수 있는 포스팅 초안을 작성하세요.

[작성 조건]
${outputLanguageLine(state.language)}
- 톤: ${TONE_LABELS[state.tone] || TONE_LABELS.friendly}
- 분량: ${customLength}
- 글 유형: ${ARTICLE_LABELS[state.articleType] || ARTICLE_LABELS.auto}
- 대상 독자: ${String(state.audience || "일반 독자").trim()}
- 핵심 키워드: ${String(state.keywords || "주제에 맞게 추천").trim()}
- 추가 요청사항: ${String(state.requirements || "없음").trim()}${researchRules}
- 제목은 검색 노출을 고려하되 낚시성 과장은 피합니다.
- 도입부에서 결론과 핵심 요약을 먼저 제시하는 두괄식 구성을 사용합니다.
- 소제목은 내용을 예고하도록 구체적으로 작성하고, 마지막에 자연스러운 마무리 문단을 둡니다.
- seo_tags는 주제 관련 검색형 단어 4~8개를 특수기호·공백 없이 작성합니다. 비우지 않습니다.
- image_prompts는 대표 이미지 1개와 본문의 모든 h2 소제목별 이미지 1개씩을 포함합니다.
- image_prompts 항목은 slot, prompt, alt, placement_hint, heading_hint를 모두 포함합니다.
${BLOCK_RULES}${referenceBlock}

[출력 JSON]
${DRAFT_SHAPE}`;
  }

  function buildRevisionPrompt(draft, feedback, meta = {}) {
    return `아래 블로그 초안을 사용자 피드백에 맞게 수정하세요.

[수정 규칙]
${outputLanguageLine(meta.language)}
- 요청받은 부분만 자연스럽게 반영하고, 관계없는 부분은 다시 쓰지 않습니다.
- 소제목 순서, 블록 유형, 글 유형(${ARTICLE_LABELS[meta.articleType] || "자동"}), 서식 프리셋(${meta.formatPreset || "clean"})을 유지합니다.
- 사용자가 직접 추가한 내용과 원문 언어를 유지합니다.
- 기존 image_prompts의 개수와 소제목 연결을 유지하고, 수정이 필요한 프롬프트만 고칩니다.
${BLOCK_RULES}

[현재 초안 JSON]
${JSON.stringify({
      title: draft?.title || "",
      summary: draft?.summary || "",
      content: draft?.content || [],
      seo_tags: draft?.tags || [],
      image_prompts: (draft?.imagePrompts || []).map((entry) => ({
        slot: entry.slot,
        prompt: entry.prompt,
        alt: entry.alt,
        placement_hint: entry.placementHint,
        heading_hint: entry.headingHint,
      })),
    }, null, 2)}

[사용자 피드백]
${String(feedback || "").trim()}

[출력 JSON]
${DRAFT_SHAPE}`;
  }

  function buildSingleImagePrompt(entry, draft, options = {}) {
    const ratio = String(options.ratio || "auto").trim();
    const style = String(options.style || "").trim();
    const extra = String(options.requirements || "").trim();
    const heading = entry?.headingHint ? `관련 소제목: ${entry.headingHint}` : "";
    const infoSlide = options.mode === "info-slide";
    const lines = [
      "블로그 본문에 들어갈 이미지를 1장 생성하세요.",
      infoSlide
        ? "- 정보 슬라이드/카드뉴스 형태: 큰 제목과 짧은 핵심 문구, 여백이 넉넉한 인포그래픽 레이아웃"
        : "- 사진 또는 일러스트 중심으로 소재와 분위기를 표현하고, 글자는 최소화",
      `- 글 주제: ${draft?.title || ""}`,
      entry?.slot ? `- 이미지 위치: ${entry.slot}` : "",
      entry?.prompt ? `- 이미지 설명: ${entry.prompt}` : "",
      heading,
      style ? `- 이미지 스타일: ${style}` : "",
      extra ? `- 추가 요청: ${extra}` : "",
      ratio !== "auto" ? `- 이미지 비율: ${ratio}` : "",
      infoSlide ? "- 이미지 안의 문구는 이미지 설명에 맞는 짧은 한국어 문장으로 넣습니다." : "",
      "결과 이미지만 생성하고 설명 문장은 출력하지 않습니다.",
    ];
    return lines.filter(Boolean).join("\n");
  }

  function buildInstagramCaptionPrompt(state = {}) {
    const count = Math.max(1, Number(state.imageCount) || 1);
    const cardnews = state.postFormat === "cardnews";
    return `Instagram 게시물 캡션과 이미지 프롬프트를 작성하세요.

[조건]
${outputLanguageLine(state.language)}
- 주제와 요청사항: ${String(state.topic || "자유 주제").trim()}
- 캡션은 첫 두 줄에서 시선을 끌고, 마지막에 자연스러운 행동 유도 문장을 둡니다.
- 캡션은 2,200자 이내, 해시태그 5~12개를 본문 끝에 붙입니다.
- 이미지 프롬프트는 정확히 ${count}개, 서로 다른 장면으로 작성합니다.
${cardnews ? '- 카드뉴스 구성: 표지 → 핵심 내용 → 예시 → 마무리 순서로 장별 문구(장당 40자 이내)를 만듭니다.' : ""}
- 이미지 스타일: ${String(state.imageStyle || "주제에 맞게").trim()}
- 반드시 JSON만 출력합니다.

[출력 JSON]
{
  "caption": "캡션 + 해시태그",
  "images": [
    { "title": "장별 짧은 문구", "prompt": "이미지 생성 프롬프트", "alt": "대체 텍스트" }
  ]
}`;
  }

  function buildThreadsPrompt(state = {}) {
    const count = Math.max(1, Number(state.postCount) || 1);
    const cardnews = state.postFormat === "cardnews";
    return `Threads 게시물을 작성하세요.

[조건]
${outputLanguageLine(state.language)}
- 주제와 요청사항: ${String(state.topic || "자유 주제").trim()}
- ${count === 1 ? "한 개의 짧은 글(500자 이하)을 작성합니다." : `${count}개의 연결된 글을 작성합니다. 각 글은 500자 이하이며 앞뒤가 자연스럽게 이어져야 합니다.`}
- 이모지는 과하지 않게, 문단은 짧게 유지합니다.
- 해시태그는 2~4개만 사용합니다.
${cardnews ? '- 카드뉴스 이미지 프롬프트에는 장별 문구를 40자 이내로 넣습니다.' : ""}
- 반드시 JSON만 출력합니다.

[출력 JSON]
{
  "posts": [{ "text": "게시할 글" }],
  "images": [{ "title": "장별 짧은 문구", "prompt": "이미지 생성 프롬프트", "alt": "대체 텍스트" }]
}`;
  }

  /* ------------------------------------------------ photo writer (내 사진) -- */

  const PHOTO_TONE_LABELS = {
    friendly: '친근하고 유익한 해요체',
    expert: '전문적이고 신뢰감 있는 정보 전달체',
    review: '생생한 솔직 내돈내산 리뷰',
    humor: '재치 있고 흥미진진한 친근한 어조',
  };

  function buildPhotoAnalysisPrompt(count) {
    return `첨부한 사진 ${count}장을 분석해 글쓰기에 활용할 정보를 JSON으로 정리하세요.

[규칙]
- 사진에서 실제로 보이는 것만 적고, 추측은 '추정'이라고 표시합니다.
- 각 사진의 장면, 피사체, 분위기, 색감, 글에 쓸 포인트를 정리합니다.
- 사진 속에 읽히는 글자가 있으면 그대로 옮깁니다.
- 반드시 JSON만 출력합니다.

[출력 JSON]
{
  'photos': [
    {
      'index': 1,
      'scene': '장면 설명',
      'subjects': ['피사체1', '피사체2'],
      'mood': '분위기',
      'colors': '색감',
      'visibleText': '사진 속 글자',
      'useFor': '글의 어느 부분에 쓰면 좋은지',
      'best': true
    }
  ]
}`;
  }

  function buildPhotoArticlePrompt(options = {}) {
    const photoCount = Math.max(1, Number(options.photoCount) || 1);
    const usage = Math.max(1, Math.min(photoCount, Number(options.usageCount) || photoCount));
    const analysis = Array.isArray(options.analysis) ? options.analysis : [];
    const analysisText = analysis.length
      ? analysis.map((photo, index) => `- 사진 ${photo.index || index + 1}: ${photo.scene || ''} | 피사체: ${(photo.subjects || []).join(', ')} | 분위기: ${photo.mood || ''} | 색감: ${photo.colors || ''} | 글자: ${photo.visibleText || '없음'} | 활용: ${photo.useFor || ''}`).join('\n')
      : '- 사진 분석 정보 없음. 사진이 첨부된 글이라고 가정하고 자연스럽게 서술합니다.';
    return `사용자가 직접 찍은 사진과 메모를 바탕으로 네이버 블로그 포스팅을 작성하세요.

[작성 조건]
${outputLanguageLine(options.language)}
- 주제/제목 힌트: ${String(options.topic || '사진에 맞게 자동 생성').trim()}
- 작성할 내용(사용자 메모): ${String(options.content || '').trim() || '사진을 참고해 자연스럽게 작성'}
- 문체: ${PHOTO_TONE_LABELS[options.tone] || PHOTO_TONE_LABELS.friendly}
- 추가 요청: ${String(options.guide || '없음').trim()}
- 사진 ${photoCount}장 중 ${usage}장을 본문에 배치합니다.
- 사진은 반드시 사용자가 찍은 실제 사진이므로, 사진에 없는 사물이나 장소를 지어내지 않습니다.
- 사진 분석 결과가 있으면 장면·분위기·디테일을 구체적으로 살려 씁니다.
- 글 흐름상 사진이 필요한 위치에 image 블록을 넣고 index로 사진 번호를 지정합니다. 같은 사진을 두 번 쓰지 않습니다.
- 도입부에서 결론과 핵심 요약을 먼저 제시하고, 마지막에 자연스러운 마무리 문단을 둡니다.
- seo_tags는 주제 관련 검색형 단어 4~8개를 특수기호·공백 없이 작성합니다.
${BLOCK_RULES}
- image 블록은 {"type":"image","index":사진번호,"caption":"짧은 설명"} 형식을 사용합니다.

[사진 분석 결과]
${analysisText}

[출력 JSON]
{
  'title': '제목',
  'summary': '핵심 요약 1~2문장',
  'content': [
    { 'type': 'paragraph', 'text': '도입부' },
    { 'type': 'image', 'index': 1, 'caption': '사진 설명' },
    { 'type': 'heading', 'level': 2, 'text': '1. 소제목' },
    { 'type': 'paragraph', 'text': '본문' }
  ],
  'seo_tags': ['태그1', '태그2'],
  'review_questions': ['확인 질문']
}`;
  }

  function buildImageRepairPrompt(originalPrompt) {
    return `${originalPrompt}\n\n직전 요청에서 쓸 수 있는 이미지를 얻지 못했습니다. 같은 내용을 다시 생성하고, 이번에는 이미지 1장만 결과로 보여 주세요.`;
  }

  globalThis.ddalkkakPrompts = Object.freeze({
    TONE_LABELS,
    LENGTH_LABELS,
    ARTICLE_LABELS,
    buildBlogDraftPrompt,
    buildRevisionPrompt,
    buildSingleImagePrompt,
    buildInstagramCaptionPrompt,
    buildThreadsPrompt,
    buildPhotoAnalysisPrompt,
    buildPhotoArticlePrompt,
    PHOTO_TONE_LABELS,
    buildImageRepairPrompt,
  });
})();
