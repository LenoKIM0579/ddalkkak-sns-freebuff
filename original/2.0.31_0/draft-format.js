// Shared presentation rules for the panel and draft-edit popup.
// Receives explicit settings: no page state, network requests or storage writes.
(() => {
function resolveFormatPresetValue(value, articleType = "auto") {
  const preset = String(value || "auto").toLowerCase().trim();
  if (["clean", "magazine", "review", "comparison", "checklist", "emotional"].includes(preset)) return preset;
  return ({review:"review", comparison:"comparison", howto:"checklist", checklist:"checklist", place:"magazine", story:"emotional"})[articleType] || "clean";
}
function mergeInlineStyle(element, declarations) {
  if (!element?.style || !declarations || typeof declarations !== "object") {
    return;
  }

  for (const [property, value] of Object.entries(declarations)) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    element.style.setProperty(property, String(value));
  }
}
function normalizeTemplateAccentColor(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : "";
}
function mixHexColors(baseColor, targetColor, targetWeight) {
  const base = normalizeTemplateAccentColor(baseColor) || "#7d9463";
  const target = normalizeTemplateAccentColor(targetColor) || "#ffffff";
  const weight = Math.min(1, Math.max(0, Number(targetWeight) || 0));
  const channel = (color, offset) => Number.parseInt(color.slice(offset, offset + 2), 16);
  const mixed = [1, 3, 5].map((offset) => {
    const value = Math.round(channel(base, offset) * (1 - weight) + channel(target, offset) * weight);
    return value.toString(16).padStart(2, "0");
  });
  return `#${mixed.join("")}`;
}
// Both preview surfaces retain the same list tree with their own text renderer.
function renderListBlock(block, options = {}) {
  const formatValue = options.formatValue || (value => typeof value === 'object' ? '' : String(value ?? '').trim());
  const renderText = options.renderText || (value => String(value).replace(/[&<>"']/g,
    char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'})[char]));
  const active = new WeakSet();
  function normalizeItems(value, depth = 0) {
    if (depth > 8) return [];
    const source = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
    return source.flatMap(item => {
      if (item == null) return [];
      if (typeof item !== 'object' || Array.isArray(item)) {
        const text = formatValue(item);
        return text ? [{text, children: [], ordered: false}] : [];
      }
      if (active.has(item)) return [];
      active.add(item);
      const childSource = item.children ?? item.items ?? item.subitems ?? item.sub_items;
      const label = formatValue(item.label ?? item.title ?? item.name ?? item.heading ?? '');
      const detail = formatValue(item.text ?? item.content ?? item.description ?? item.value ?? '');
      const content = Object.fromEntries(Object.entries(item).filter(([key]) =>
        !['children', 'items', 'subitems', 'sub_items', 'ordered'].includes(key)));
      const text = label || detail || formatValue(content);
      const children = normalizeItems(childSource, depth + 1);
      if (label && detail && label !== detail) children.unshift({text: detail, children: [], ordered: false});
      if (label || detail) {
        const extra = formatValue(Object.fromEntries(Object.entries(content).filter(([key]) =>
          !['label', 'title', 'name', 'heading', 'text', 'content', 'description', 'value'].includes(key))));
        if (extra) children.push({text: extra, children: [], ordered: false});
      }
      active.delete(item);
      return text ? [{text, children, ordered: item.ordered === true}] : children;
    });
  }
  const source = block.items ?? block.values ?? block.options ?? block.entries
    ?? block.text ?? block.value ?? block.content;
  const items = normalizeItems(source);
  if (!items.length) return null;
  const ordered = ['ordered-list', 'ol'].includes(String(block.type || '').toLowerCase()) || block.ordered === true;
  const checklist = block.type === 'checklist';
  function renderItems(nodes, numbered, depth = 0) {
    const tag = numbered ? 'ol' : 'ul';
    return `<${tag}>${nodes.map(item => `<li>${renderText((checklist && depth === 0 ? '✓ ' : '') + item.text)}${item.children.length ? renderItems(item.children, item.ordered, depth + 1) : ''}</li>`).join('')}</${tag}>`;
  }
  function plainItems(nodes, depth = 0) {
    return nodes.flatMap(item => ['  '.repeat(depth) + (checklist && depth === 0 ? '✓ ' : '') + item.text,
      ...plainItems(item.children, depth + 1)]);
  }
  return {html: renderItems(items, ordered), text: plainItems(items).join('\n')};
}

function applyEditorialThemeToHtml(html, options = {}) {
  const source = String(html || "").trim();

  if (!source) {
    return "";
  }

  const template = document.createElement("template");
  template.innerHTML = source;
  const content = template.content;
  const paragraphs = Array.from(content.querySelectorAll("p"));
  const firstParagraph = paragraphs[0] || null;
  const theme = getEditorialTheme(resolveFormatPresetValue(options.preset, options.articleType), options.accentColor);

  for (const node of Array.from(content.querySelectorAll("blockquote, h2, h3, p, ul, ol, li, a, img"))) {
    if (node.tagName === "BLOCKQUOTE") {
      mergeInlineStyle(node, {
        margin: "30px 0 34px",
        padding: "22px 24px",
        "background-color": theme.calloutBackground,
        color: theme.calloutText,
        "border-left": `4px solid ${theme.accent}`,
        "border-radius": "14px",
        "font-size": "17px",
        "font-weight": "600",
        "line-height": "1.95",
        "letter-spacing": "-0.01em",
      });
      continue;
    }

    if (node.tagName === "H2") {
      mergeInlineStyle(node, {
        margin: "42px 0 18px",
        padding: "15px 18px 14px",
        "background-color": theme.headingBackground,
        color: theme.headingText,
        "border-left": `6px solid ${theme.accent}`,
        "border-radius": "12px",
        "font-size": "25px",
        "font-weight": "700",
        "line-height": "1.5",
        "letter-spacing": "-0.02em",
      });
      continue;
    }

    if (node.tagName === "H3") {
      mergeInlineStyle(node, {
        margin: "28px 0 14px",
        color: theme.subheadingText,
        "font-size": "21px",
        "font-weight": "700",
        "line-height": "1.55",
        "letter-spacing": "-0.015em",
      });
      continue;
    }

    if (node.tagName === "P") {
      mergeInlineStyle(node, {
        margin: node === firstParagraph ? "0 0 20px" : "0 0 18px",
        color: theme.bodyText,
        "font-size": node === firstParagraph ? "18px" : "17px",
        "line-height": node === firstParagraph ? "2" : "1.95",
        "letter-spacing": "-0.01em",
      });
      continue;
    }

    if (node.tagName === "UL" || node.tagName === "OL") {
      const nested = Boolean(node.parentElement?.closest('li'));
      mergeInlineStyle(node, {
        margin: nested ? "6px 0 8px" : "0 0 20px",
        padding: "0 0 0 22px",
        color: theme.bodyText,
        "font-size": "16px",
        "line-height": "1.9",
      });
      continue;
    }

    if (node.tagName === "LI") {
      mergeInlineStyle(node, {
        margin: "0 0 8px",
      });
      continue;
    }

    if (node.tagName === "A") {
      mergeInlineStyle(node, {
        color: theme.linkText,
        "text-decoration": "underline",
      });
      continue;
    }

    if (node.tagName === "IMG") {
      mergeInlineStyle(node, {
        display: "block",
        margin: "26px auto",
        "border-radius": "16px",
        width: "100%",
      });
    }
  }

  return template.innerHTML;
}

function getEditorialTheme(preset, accentColor = "") {
  const themes = {
    clean: {
      accent: "#7d9463",
      headingBackground: "#f5f8f1",
      headingText: "#24321f",
      subheadingText: "#5f744d",
      calloutBackground: "#f7faf4",
      calloutText: "#405337",
      bodyText: "#2d2924",
      linkText: "#2f6b5f",
    },
    magazine: {
      accent: "#315a8c",
      headingBackground: "#f1f5fb",
      headingText: "#1f3552",
      subheadingText: "#315a8c",
      calloutBackground: "#f5f8fc",
      calloutText: "#334b67",
      bodyText: "#272b31",
      linkText: "#245f9e",
    },
    review: {
      accent: "#d97745",
      headingBackground: "#fff5ee",
      headingText: "#713c24",
      subheadingText: "#a35431",
      calloutBackground: "#fff8f2",
      calloutText: "#74462f",
      bodyText: "#332b27",
      linkText: "#aa542e",
    },
    comparison: {
      accent: "#6657a5",
      headingBackground: "#f5f3fb",
      headingText: "#392f62",
      subheadingText: "#6657a5",
      calloutBackground: "#f8f6fd",
      calloutText: "#4d426f",
      bodyText: "#2d2a35",
      linkText: "#5d4fa0",
    },
    checklist: {
      accent: "#16847b",
      headingBackground: "#eef9f7",
      headingText: "#174d49",
      subheadingText: "#16736b",
      calloutBackground: "#f0faf8",
      calloutText: "#285e59",
      bodyText: "#263331",
      linkText: "#0e756d",
    },
    emotional: {
      accent: "#b76d7d",
      headingBackground: "#fcf3f5",
      headingText: "#663b45",
      subheadingText: "#9b5867",
      calloutBackground: "#fdf7f1",
      calloutText: "#705044",
      bodyText: "#352d2f",
      linkText: "#9c5364",
    },
  };
  const baseTheme = themes[resolveFormatPresetValue(preset)] || themes.clean;
  const customAccent = normalizeTemplateAccentColor(accentColor);
  if (!customAccent) {
    return { ...baseTheme };
  }

  return {
    ...baseTheme,
    accent: customAccent,
    headingBackground: mixHexColors(customAccent, "#ffffff", 0.9),
    headingText: mixHexColors(customAccent, "#000000", 0.55),
    subheadingText: mixHexColors(customAccent, "#000000", 0.24),
    calloutBackground: mixHexColors(customAccent, "#ffffff", 0.94),
    calloutText: mixHexColors(customAccent, "#000000", 0.5),
    linkText: mixHexColors(customAccent, "#000000", 0.2),
  };
}
globalThis.ddalkkakDraftFormat = Object.freeze({ applyTheme: applyEditorialThemeToHtml, getTheme: getEditorialTheme, resolvePreset: resolveFormatPresetValue, renderListBlock });
})();

