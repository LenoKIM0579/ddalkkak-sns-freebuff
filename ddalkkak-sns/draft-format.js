// Draft data model shared by the panel and the preview.
// Pure functions only: no storage, no network, no page state.
(() => {
  const PRESETS = ["clean", "magazine", "review", "comparison", "checklist", "emotional"];
  const ARTICLE_TO_PRESET = {
    review: "review",
    comparison: "comparison",
    howto: "checklist",
    checklist: "checklist",
    place: "magazine",
    story: "emotional",
  };

  const THEMES = {
    clean: { accent: "#7d9463", headingBackground: "#f5f8f1", headingText: "#24321f", subheadingText: "#5f744d", calloutBackground: "#f7faf4", calloutText: "#405337", bodyText: "#2d2924", linkText: "#2f6b5f" },
    magazine: { accent: "#315a8c", headingBackground: "#f1f5fb", headingText: "#1f3552", subheadingText: "#315a8c", calloutBackground: "#f5f8fc", calloutText: "#334b67", bodyText: "#272b31", linkText: "#245f9e" },
    review: { accent: "#d97745", headingBackground: "#fff5ee", headingText: "#713c24", subheadingText: "#a35431", calloutBackground: "#fff8f2", calloutText: "#74462f", bodyText: "#332b27", linkText: "#aa542e" },
    comparison: { accent: "#6657a5", headingBackground: "#f5f3fb", headingText: "#392f62", subheadingText: "#6657a5", calloutBackground: "#f8f6fd", calloutText: "#4d426f", bodyText: "#2d2a35", linkText: "#5d4fa0" },
    checklist: { accent: "#16847b", headingBackground: "#eef9f7", headingText: "#174d49", subheadingText: "#16736b", calloutBackground: "#f0faf8", calloutText: "#285e59", bodyText: "#263331", linkText: "#0e756d" },
    emotional: { accent: "#b76d7d", headingBackground: "#fcf3f5", headingText: "#663b45", subheadingText: "#9b5867", calloutBackground: "#fdf7f1", calloutText: "#705044", bodyText: "#352d2f", linkText: "#9c5364" },
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  }

  function normalizeAccentColor(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : "";
  }

  function mixHexColors(baseColor, targetColor, targetWeight) {
    const base = normalizeAccentColor(baseColor) || "#7d9463";
    const target = normalizeAccentColor(targetColor) || "#ffffff";
    const weight = Math.min(1, Math.max(0, Number(targetWeight) || 0));
    const channel = (color, offset) => Number.parseInt(color.slice(offset, offset + 2), 16);
    const mixed = [1, 3, 5].map((offset) => {
      const value = Math.round(channel(base, offset) * (1 - weight) + channel(target, offset) * weight);
      return value.toString(16).padStart(2, "0");
    });
    return `#${mixed.join("")}`;
  }

  function resolvePreset(value, articleType = "auto") {
    const preset = String(value || "auto").trim().toLowerCase();
    if (PRESETS.includes(preset)) return preset;
    return ARTICLE_TO_PRESET[articleType] || "clean";
  }

  function getTheme(preset, accentColor = "") {
    const base = THEMES[resolvePreset(preset)] || THEMES.clean;
    const accent = normalizeAccentColor(accentColor);
    if (!accent) return { ...base };
    return {
      ...base,
      accent,
      headingBackground: mixHexColors(accent, "#ffffff", 0.9),
      headingText: mixHexColors(accent, "#000000", 0.55),
      subheadingText: mixHexColors(accent, "#000000", 0.24),
      calloutBackground: mixHexColors(accent, "#ffffff", 0.94),
      calloutText: mixHexColors(accent, "#000000", 0.5),
      linkText: mixHexColors(accent, "#000000", 0.2),
    };
  }

  // Inline rules understood by the prompt: **bold**, [text](color:#hex), [text](bg:yellow).
  function renderInline(value) {
    let html = escapeHtml(value);
    html = html.replace(/\[([^\]]+)\]\(color:(#?[a-zA-Z0-9]+)\)/g,
      '<span style="color:$2;font-weight:600">$1</span>');
    html = html.replace(/\[([^\]]+)\]\(bg:(#?[a-zA-Z0-9]+)\)/g,
      '<span style="background-color:$2">$1</span>');
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return html;
  }

  function toPlainText(value) {
    return String(value ?? "")
      .replace(/\[([^\]]+)\]\((?:color|bg):[^)]+\)/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/&nbsp;/g, " ")
      .trim();
  }

  function normalizeListItems(value, depth = 0) {
    if (depth > 4) return [];
    const source = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
    return source.flatMap((item) => {
      if (item == null) return [];
      if (typeof item !== "object" || Array.isArray(item)) {
        const text = toPlainText(item);
        return text ? [{ text, children: [] }] : [];
      }
      const label = String(item.text ?? item.label ?? item.title ?? "").trim();
      const children = normalizeListItems(item.children ?? item.items ?? item.subitems, depth + 1);
      return label || children.length ? [{ text: label, children }] : [];
    });
  }

  function renderList(items, { ordered = false, checklist = false } = {}) {
    const tag = ordered ? "ol" : "ul";
    const nodes = items.map((item) => {
      const prefix = checklist ? "✓ " : "";
      const children = item.children.length
        ? renderList(item.children, { ordered: false, checklist: false })
        : "";
      return `<li>${prefix ? `<span style="font-weight:700">${prefix}</span>` : ""}${renderInline(item.text)}${children}</li>`;
    });
    return `<${tag}>${nodes.join("")}</${tag}>`;
  }

  function blockToHtml(block, theme, options = {}) {
    const type = String(block?.type || "paragraph").trim().toLowerCase();
    const text = String(block?.text ?? block?.content ?? "").trim();
    switch (type) {
      case "heading": {
        const level = Number(block.level) === 3 ? 3 : 2;
        const style = level === 2
          ? `margin:42px 0 18px;padding:15px 18px 14px;background-color:${theme.headingBackground};color:${theme.headingText};border-left:6px solid ${theme.accent};border-radius:12px;font-size:25px;font-weight:700;line-height:1.5;`
          : `margin:28px 0 14px;color:${theme.subheadingText};font-size:21px;font-weight:700;line-height:1.55;`;
        return text ? `<h${level} style="${style}">${renderInline(text)}</h${level}>` : "";
      }
      case "lead":
        return text
          ? `<p style="margin:0 0 22px;padding:18px 20px;background-color:${theme.calloutBackground};color:${theme.calloutText};border-radius:14px;font-size:18px;font-weight:600;line-height:1.95;">${renderInline(text)}</p>`
          : "";
      case "blockquote":
        return text
          ? `<blockquote style="margin:30px 0 34px;padding:22px 24px;background-color:${theme.calloutBackground};color:${theme.calloutText};border-left:4px solid ${theme.accent};border-radius:14px;font-size:17px;font-weight:600;line-height:1.95;">${renderInline(text)}</blockquote>`
          : "";
      case "callout": {
        const title = String(block.title || "").trim();
        if (!text && !title) return "";
        return `<div style="margin:26px 0;padding:18px 20px;background-color:${theme.calloutBackground};border:1px solid ${theme.accent}33;border-radius:14px;color:${theme.calloutText};">${title ? `<p style="margin:0 0 8px;font-weight:700;font-size:16px;">${escapeHtml(title)}</p>` : ""}${text ? `<p style="margin:0;font-size:16px;line-height:1.9;">${renderInline(text)}</p>` : ""}</div>`;
      }
      case "list":
      case "ordered-list":
      case "checklist": {
        const items = normalizeListItems(block.items ?? block.values ?? block.text ?? block.content);
        if (!items.length) return "";
        const list = renderList(items, {
          ordered: type === "ordered-list" || block.ordered === true,
          checklist: type === "checklist",
        });
        return `<div style="margin:0 0 20px;padding:0 0 0 22px;color:${theme.bodyText};font-size:16px;line-height:1.9;">${list}</div>`;
      }
      case "steps": {
        const items = normalizeListItems(block.items ?? block.text ?? block.content);
        if (!items.length) return "";
        const rows = items.map((item, index) =>
          `<li style="margin:0 0 10px;">${renderInline(item.text)}${item.children.length ? renderList(item.children) : ""}</li>`);
        return `<ol style="margin:0 0 20px;padding:0 0 0 22px;color:${theme.bodyText};font-size:16px;line-height:1.9;">${rows.join("")}</ol>`;
      }
      case "pros_cons": {
        const pros = normalizeListItems(block.pros ?? block.items?.pros);
        const cons = normalizeListItems(block.cons ?? block.items?.cons);
        if (!pros.length && !cons.length) return "";
        const box = (label, items, color) => items.length
          ? `<div style="padding:14px 16px;background-color:${color}14;border-radius:12px;"><p style="margin:0 0 8px;font-weight:700;color:${color};">${label}</p>${renderList(items, { checklist: true })}</div>`
          : "";
        return `<div style="display:grid;gap:10px;margin:26px 0;font-size:16px;line-height:1.85;">${box("장점", pros, "#16847b")}${box("단점", cons, "#d97745")}</div>`;
      }
      case "comparison": {
        const rows = Array.isArray(block.rows) ? block.rows : Array.isArray(block.items) ? block.items : [];
        const headers = Array.isArray(block.headers) ? block.headers : [];
        if (!rows.length) return "";
        const head = headers.length
          ? `<tr>${headers.map((cell) => `<th style="border:1px solid ${theme.accent}33;padding:8px;background-color:${theme.headingBackground};text-align:left;">${escapeHtml(cell)}</th>`).join("")}</tr>`
          : "";
        const body = rows.map((row) => {
          const cells = Array.isArray(row) ? row : Object.values(row || {});
          return `<tr>${cells.map((cell) => `<td style="border:1px solid ${theme.accent}33;padding:8px;">${renderInline(cell)}</td>`).join("")}</tr>`;
        }).join("");
        return `<table style="width:100%;border-collapse:collapse;margin:26px 0;font-size:15px;line-height:1.7;">${head}${body}</table>`;
      }
      case "faq": {
        const items = Array.isArray(block.items) ? block.items : [];
        if (!items.length) return "";
        const rows = items.map((item) => {
          const question = String(item?.question ?? item?.q ?? "").trim();
          const answer = String(item?.answer ?? item?.a ?? "").trim();
          return `<div style="margin:0 0 14px;"><p style="margin:0 0 4px;font-weight:700;color:${theme.headingText};">Q. ${escapeHtml(question)}</p><p style="margin:0;color:${theme.bodyText};">${renderInline(answer)}</p></div>`;
        }).join("");
        return `<div style="margin:26px 0;padding:18px 20px;background-color:#fafafa;border-radius:14px;font-size:16px;line-height:1.85;">${rows}</div>`;
      }
      case "cta":
        return text
          ? `<p style="margin:30px 0;padding:18px 20px;text-align:center;background-color:${theme.accent};color:#ffffff;border-radius:14px;font-size:17px;font-weight:700;line-height:1.8;">${renderInline(text)}</p>`
          : "";
      case "image": {
        if (!options.photoSlots) return "<p></p>";
        const rawIndex = Number(block.index ?? block.photoIndex ?? block.slot);
        const slot = Number.isFinite(rawIndex) && rawIndex > 0 ? rawIndex - 1 : 0;
        const caption = String(block.caption || "").trim();
        const marker = `<p data-photo-slot="${slot}" style="margin:8px 0;"></p>`;
        return caption
          ? `${marker}<p style="margin:0 0 14px;text-align:center;color:#6b7280;font-size:13px;">${renderInline(caption)}</p>`
          : marker;
      }
      default:
        return text
          ? `<p style="margin:0 0 18px;color:${theme.bodyText};font-size:17px;line-height:1.95;">${renderInline(text)}</p>`
          : "";
    }
  }

  function normalizeBlocks(value) {
    if (Array.isArray(value)) {
      return value
        .map((block) => (typeof block === "string"
          ? { type: "paragraph", text: block }
          : block && typeof block === "object" ? block : null))
        .filter(Boolean);
    }
    const html = String(value || "").trim();
    if (!html) return [];
    return html
      .split(/<\/(?:p|div|h2|h3|li|blockquote)>/i)
      .map((chunk) => chunk.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((text) => ({ type: "paragraph", text }));
  }

  function blocksToHtml(blocks, options = {}) {
    const theme = getTheme(options.preset, options.accentColor);
    return (Array.isArray(blocks) ? blocks : [])
      .map((block) => blockToHtml(block, theme, options))
      .filter(Boolean)
      .join("\n");
  }

  function blocksToPlainText(blocks) {
    const lines = [];
    for (const block of Array.isArray(blocks) ? blocks : []) {
      const type = String(block?.type || "paragraph").toLowerCase();
      const text = toPlainText(block?.text ?? block?.content ?? "");
      if (type === "heading") {
        if (text) lines.push(`\n${text}\n`);
        continue;
      }
      if (["list", "ordered-list", "checklist", "steps"].includes(type)) {
        for (const item of normalizeListItems(block.items ?? block.values ?? block.text)) {
          lines.push(`- ${item.text}`);
          for (const child of item.children) lines.push(`  - ${child.text}`);
        }
        lines.push("");
        continue;
      }
      if (text) lines.push(text, "");
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function normalizeTags(value) {
    return Array.from(new Set((Array.isArray(value) ? value : [])
      .map((tag) => String(tag || "").replace(/[#\s]/g, "").trim())
      .filter(Boolean)))
      .slice(0, 10);
  }

  function normalizeImagePrompts(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry, index) => {
        const prompt = typeof entry === "string" ? entry : entry?.prompt || entry?.text || "";
        return {
          slot: String(entry?.slot || (index === 0 ? "대표 이미지" : `${index}번 소제목 이미지`)).trim(),
          prompt: String(prompt || "").trim(),
          alt: String(entry?.alt || "").trim(),
          placementHint: String(entry?.placement_hint || entry?.placementHint || "문단 중간 배치").trim(),
          headingHint: String(entry?.heading_hint || entry?.headingHint || "").trim(),
        };
      })
      .filter((entry) => entry.prompt);
  }

  // Models often emit stray newlines inside strings; repair before giving up.
  function repairJsonMultilineStrings(source) {
    let repaired = "";
    let inString = false;
    let escaped = false;
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) { repaired += character; escaped = false; continue; }
        if (character === "\\") { repaired += character; escaped = true; continue; }
        if (character === "\r") { repaired += "\\n"; if (source[index + 1] === "\n") index += 1; continue; }
        if (character === "\n") { repaired += "\\n"; continue; }
        if (character === "\t") { repaired += "\\t"; continue; }
        if (character === '"') {
          let next = index + 1;
          while (next < source.length && /\s/.test(source[next])) next += 1;
          const following = source[next];
          if (following && ![",", "}", "]", ":"].includes(following)) { repaired += '\\"'; continue; }
          repaired += character;
          inString = false;
          continue;
        }
        repaired += character;
        continue;
      }
      if (character === '"') inString = true;
      repaired += character;
    }
    return repaired;
  }

  function parseJsonFromText(text) {
    const source = String(text || "").trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/i, "")
      .trim();
    if (!source) return null;
    const candidates = [source];
    const first = source.indexOf("{");
    const last = source.lastIndexOf("}");
    if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1));
    for (const candidate of candidates) {
      try { return JSON.parse(candidate); } catch { /* try repaired */ }
      const repaired = repairJsonMultilineStrings(candidate);
      if (repaired !== candidate) {
        try { return JSON.parse(repaired); } catch { /* give up */ }
      }
    }
    return null;
  }

  function normalizeDraft(value, fallback = null) {
    if (!value || typeof value !== "object") return fallback || null;
    const blocks = normalizeBlocks(value.content ?? value.blocks ?? value.body);
    const title = String(value.title || value.post_title || fallback?.title || "").trim();
    const summary = String(value.summary || value.description || value.excerpt || fallback?.summary || "").trim();
    const imagePrompts = normalizeImagePrompts(value.image_prompts ?? value.imagePrompts ?? fallback?.imagePrompts);
    const reviewQuestions = (Array.isArray(value.review_questions) ? value.review_questions : [])
      .map((question) => String(question || "").trim())
      .filter(Boolean);
    return {
      title,
      summary,
      content: blocks,
      html: blocksToHtml(blocks),
      text: blocksToPlainText(blocks),
      tags: normalizeTags(value.seo_tags ?? value.tags ?? fallback?.tags),
      imagePrompts,
      reviewQuestions,
    };
  }

  function parseDraftResponse(text, fallbackDraft = null) {
    const parsed = parseJsonFromText(text);
    if (parsed && typeof parsed === "object") return normalizeDraft(parsed, fallbackDraft);
    return normalizeDraft({
      title: fallbackDraft?.title || "",
      summary: "AI가 반환한 텍스트 초안입니다.",
      content: [{ type: "paragraph", text: String(text || "").trim() }],
      seo_tags: fallbackDraft?.tags || [],
      image_prompts: fallbackDraft?.imagePrompts || [],
    }, fallbackDraft);
  }

  function countCharacters(text) {
    return String(text || "").replace(/\s/g, "").length;
  }

  globalThis.ddalkkakDraftFormat = Object.freeze({
    escapeHtml,
    renderInline,
    getTheme,
    resolvePreset,
    normalizeAccentColor,
    blocksToHtml,
    blocksToPlainText,
    normalizeDraft,
    parseDraftResponse,
    parseJsonFromText,
    normalizeTags,
    normalizeImagePrompts,
    countCharacters,
  });
})();
