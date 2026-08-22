import type { MarkedExtension, RendererExtension, TokenizerExtension, Tokens } from "marked";

interface MathToken extends Tokens.Generic {
  type: "inlineMath" | "blockMath";
  text: string;
  displayMode: boolean;
}

const inlineRule = /^(\${1,2})(?!\$)((?:\\.|[^\\\n])*?(?:\\.|[^\\\n\$]))\1(?=[\s?!.,:;，。？！：；、）】》\p{Script=Han}]|$)/u;
const blockRule = /^(\${1,2})\n((?:\\[^]|[^\\])+?)\n\1(?:\n|$)/;

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function placeholder(token: MathToken, newline = false) {
  const delimiter = token.displayMode ? "$$" : "$";
  return `<span class="math-source" data-katex="${encodeURIComponent(token.text)}" data-display="${token.displayMode}">${escapeHtml(`${delimiter}${token.text}${delimiter}`)}</span>${newline ? "\n" : ""}`;
}

const inlineMath: TokenizerExtension & RendererExtension = {
  name: "inlineMath",
  level: "inline",
  start(source) {
    let offset = 0;
    while (offset < source.length) {
      const index = source.indexOf("$", offset);
      if (index < 0) return;
      if (inlineRule.test(source.slice(index))) return index;
      offset = index + 1;
    }
  },
  tokenizer(source) {
    const match = source.match(inlineRule);
    if (!match) return;
    return {
      type: "inlineMath",
      raw: match[0],
      text: match[2].trim(),
      displayMode: match[1].length === 2,
    };
  },
  renderer: ((token: MathToken) => placeholder(token)) as RendererExtension["renderer"],
};

const blockMath: TokenizerExtension & RendererExtension = {
  name: "blockMath",
  level: "block",
  tokenizer(source) {
    const match = source.match(blockRule);
    if (!match) return;
    return {
      type: "blockMath",
      raw: match[0],
      text: match[2].trim(),
      displayMode: match[1].length === 2,
    };
  },
  renderer: ((token: MathToken) => placeholder(token, true)) as RendererExtension["renderer"],
};

export const markedMathExtension: MarkedExtension = {
  extensions: [inlineMath, blockMath],
};
