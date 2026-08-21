import { convertToExcalidrawElements, exportToSvg } from "@excalidraw/excalidraw";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
// @ts-expect-error The small in-house parser is plain JS and is used only for subgraph membership.
import clean from "./clean.js";
// @ts-expect-error The small in-house parser is plain JS and is used only for subgraph membership.
import parseFlow from "./flow/parse.js";
import { buildExcalidrawFlowSkeleton } from "./excalidraw-flow-model";

export type MermaidExcalidrawPalette = {
  bg: string;
  fg: string;
  line: string;
  accent: string;
  muted: string;
  surface: string;
  border: string;
};

type MermaidSkeleton = Record<string, unknown> & {
  id?: string;
  type?: string;
  label?: Record<string, unknown>;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  points?: number[][];
  start?: unknown;
  end?: unknown;
};

type ParsedSubgraph = [
  id: string,
  title: string,
  members: string[],
  directMembers: string[],
  parentId: string,
  direction: number,
];

// Match Excalidraw's current handwritten font stack. Excalifont falls back to
// Xiaolai for CJK glyphs, so mixed Chinese/Latin labels keep the same visual
// voice instead of dropping to the browser's system sans-serif font.
const EXCALIDRAW_HAND_DRAWN_FONT = 5;
const EXCALIDRAW_CONNECTOR_ROUGHNESS = 2;
// Mermaid measures its node geometry before the labels are converted to
// Excalifont. The browser-measurement pass below reconciles the final font
// metrics with those precomputed boxes.
const EXCALIDRAW_DIAGRAM_FONT_SIZE = 16;
const EXCALIDRAW_LABEL_INLINE_PADDING = 40;
const EXCALIDRAW_LABEL_BLOCK_PADDING = 24;

function normalizeExcalidrawText(value: unknown) {
  return typeof value === "string"
    ? value.replace(/<br\s*\/?\s*>/gi, "\n")
    : value;
}

function stripFlowchartSubgraphs(source: string) {
  let depth = 0;
  return source
    .split("\n")
    .filter((line) => {
      if (/^\s*subgraph\b/i.test(line)) {
        depth += 1;
        return false;
      }
      if (depth && /^\s*end\b/i.test(line)) {
        depth -= 1;
        return false;
      }
      return !(depth && /^\s*direction\b/i.test(line));
    })
    .join("\n");
}

function flowchartSubgraphs(source: string) {
  const [body] = clean(source);
  if (!/^\s*(?:flowchart|graph)\b/i.test(body)) {
    return { groups: [] as ParsedSubgraph[], horizontal: false };
  }
  const parsed = parseFlow(body);
  const direction = body.match(/^\s*(?:flowchart|graph)\s+(\w+)/i)?.[1]?.toUpperCase();
  return {
    groups: (parsed[3] || []) as ParsedSubgraph[],
    horizontal: direction === "LR" || direction === "RL",
  };
}

function boundId(value: unknown) {
  return value && typeof value === "object" && "id" in value
    ? String((value as { id: unknown }).id)
    : "";
}

function isSequenceDiagram(source: string) {
  return /^\s*sequenceDiagram\b/i.test(source);
}

/**
 * Mermaid already gives sequence messages their final SVG geometry. Binding
 * those arrows back to the actor header makes Excalidraw re-attach their
 * endpoints to the top boxes during export, which bends normal messages and
 * can collapse self messages into a few disconnected strokes.
 */
export function preserveSequenceMessageGeometry(
  sourceElements: readonly MermaidSkeleton[],
) {
  return sourceElements.map((element) => {
    if (element.type !== "arrow") return element;
    const startId = boundId(element.start);
    const endId = boundId(element.end);
    const message = { ...element };
    delete message.start;
    delete message.end;
    delete message.width;
    delete message.height;

    if (startId && startId === endId && Array.isArray(element.points)) {
      const label = normalizeExcalidrawText(element.label?.text);
      const longestLine = typeof label === "string"
        ? Math.max(...label.split("\n").map((line) => [...line].length), 0)
        : 0;
      const loopWidth = Math.max(96, Math.min(260, longestLine * 9 + 28));
      message.points = [[0, 0], [loopWidth, 0], [loopWidth, 38], [0, 38]];
    }
    return message;
  });
}

function spaceTopLevelSubgraphs(
  sourceElements: readonly MermaidSkeleton[],
  groups: readonly ParsedSubgraph[],
  horizontal: boolean,
) {
  const elements = sourceElements.map((element) => ({
    ...element,
    ...(Array.isArray(element.points)
      ? { points: (element.points as number[][]).map((point) => [...point]) }
      : {}),
  }));
  const nodeShift = new Map<string, number>();
  let previousEnd: number | null = null;
  for (const [, , members, , parentId] of groups) {
    if (parentId) continue;
    const children = elements.filter(
      (element) =>
        element.id &&
        members.includes(element.id) &&
        typeof (horizontal ? element.x : element.y) === "number" &&
        typeof (horizontal ? element.width : element.height) === "number",
    );
    if (!children.length) continue;
    const start = Math.min(
      ...children.map((child) => (horizontal ? child.x : child.y) as number),
    );
    const end = Math.max(
      ...children.map(
        (child) =>
          ((horizontal ? child.x : child.y) as number) +
          ((horizontal ? child.width : child.height) as number),
      ),
    );
    const shift: number =
      previousEnd === null ? 0 : Math.max(0, previousEnd + 80 - start);
    members.forEach((id) => nodeShift.set(id, shift));
    previousEnd = end + shift;
  }
  for (const element of elements) {
    const ownShift = element.id ? nodeShift.get(element.id) || 0 : 0;
    if (ownShift) {
      if (horizontal) element.x = (element.x as number) + ownShift;
      else element.y = (element.y as number) + ownShift;
    }
    if (!Array.isArray(element.points)) continue;
    const startShift = nodeShift.get(boundId(element.start)) || 0;
    const endShift = nodeShift.get(boundId(element.end)) || 0;
    if (!startShift && !endShift) continue;
    if (horizontal) element.x = (element.x as number) + startShift;
    else element.y = (element.y as number) + startShift;
    const points = element.points as number[][];
    const divisor = Math.max(1, points.length - 1);
    element.points = points.map((point, index) => {
      const interpolated = startShift + (endShift - startShift) * (index / divisor);
      const adjusted = [...point];
      adjusted[horizontal ? 0 : 1] += interpolated - startShift;
      return adjusted;
    });
  }
  return elements;
}

function subgraphFrames(
  elements: readonly MermaidSkeleton[],
  groups: readonly ParsedSubgraph[],
) {
  return groups.flatMap(([, title, members], index) => {
    const children = elements.filter(
      (element) =>
        element.id &&
        members.includes(element.id) &&
        typeof element.x === "number" &&
        typeof element.y === "number" &&
        typeof element.width === "number" &&
        typeof element.height === "number",
    );
    if (!children.length) return [];
    const left = Math.min(...children.map((child) => child.x as number)) - 40;
    const top = Math.min(...children.map((child) => child.y as number)) - 60;
    const right = Math.max(
      ...children.map((child) => (child.x as number) + (child.width as number)),
    ) + 40;
    const bottom = Math.max(
      ...children.map((child) => (child.y as number) + (child.height as number)),
    ) + 40;
    return [{
      id: `mermaid-subgraph-${index}`,
      type: "rectangle",
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      roughness: 1,
      customData: { mermaidSubgraph: true },
      label: {
        text: title,
        fontSize: 14,
        fontFamily: EXCALIDRAW_HAND_DRAWN_FONT,
        textAlign: "center",
        verticalAlign: "top",
      },
    } satisfies MermaidSkeleton];
  });
}

/** Theme the converted elements themselves; never fake a theme with an SVG filter. */
export function themeMermaidSkeletons(
  elements: readonly MermaidSkeleton[],
  palette: MermaidExcalidrawPalette,
) {
  return elements.map((element) => {
    const connector = element.type === "arrow" || element.type === "line";
    const text = element.type === "text";
    const subgraph = Boolean(
      (element.customData as { mermaidSubgraph?: boolean } | undefined)
        ?.mermaidSubgraph,
    );
    const themed: MermaidSkeleton = {
      ...element,
      ...(typeof element.text === "string"
        ? {
            text: normalizeExcalidrawText(element.text),
            fontSize:
              typeof element.fontSize === "number"
                ? Math.min(element.fontSize, EXCALIDRAW_DIAGRAM_FONT_SIZE)
                : EXCALIDRAW_DIAGRAM_FONT_SIZE,
          }
        : {}),
      roughness: connector ? EXCALIDRAW_CONNECTOR_ROUGHNESS : 1,
      ...(connector
        ? { strokeColor: palette.line, strokeWidth: element.strokeWidth || 2 }
        : text
          ? {
              strokeColor: palette.fg,
              fontFamily: EXCALIDRAW_HAND_DRAWN_FONT,
            }
          : {
              strokeColor: subgraph ? palette.border : palette.fg,
              strokeWidth: element.strokeWidth || 2,
              backgroundColor: "transparent",
              fillStyle: "solid",
            }),
    };
    if (element.label) {
      themed.label = {
        ...element.label,
        text: normalizeExcalidrawText(element.label.text),
        fontSize:
          typeof element.label.fontSize === "number"
            ? Math.min(element.label.fontSize, EXCALIDRAW_DIAGRAM_FONT_SIZE)
            : EXCALIDRAW_DIAGRAM_FONT_SIZE,
        strokeColor: palette.fg,
        fontFamily: EXCALIDRAW_HAND_DRAWN_FONT,
      };
    }
    return themed;
  });
}

type RenderedLineSize = { width: number; height: number };

function normalizedTextLines(value: unknown) {
  const text = normalizeExcalidrawText(value);
  if (typeof text !== "string") return [];
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Measure the actual embedded Excalifont/Xiaolai glyphs in SVG user units. */
async function measureRenderedText(svg: SVGSVGElement) {
  const mount = document.createElement("div");
  mount.style.position = "fixed";
  mount.style.left = "-100000px";
  mount.style.top = "0";
  mount.style.opacity = "0";
  mount.style.pointerEvents = "none";
  mount.append(svg);
  document.body.append(mount);
  try {
    await Promise.allSettled([
      document.fonts.load(`${EXCALIDRAW_DIAGRAM_FONT_SIZE}px Excalifont`),
      document.fonts.load(`${EXCALIDRAW_DIAGRAM_FONT_SIZE}px Xiaolai`),
    ]);
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const sizes = new Map<string, RenderedLineSize>();
    svg.querySelectorAll<SVGTextElement>("text").forEach((text) => {
      const key = text.textContent?.replace(/\s+/g, " ").trim();
      if (!key) return;
      const box = text.getBBox();
      const previous = sizes.get(key);
      if (!previous || box.width > previous.width) {
        sizes.set(key, { width: box.width, height: box.height });
      }
    });
    return sizes;
  } finally {
    mount.remove();
  }
}

function fitSkeletonsToRenderedLabels(
  elements: readonly MermaidSkeleton[],
  renderedLines: ReadonlyMap<string, RenderedLineSize>,
) {
  return elements.map((element) => {
    if (
      element.type === "arrow" ||
      element.type === "line" ||
      element.type === "text" ||
      !element.label ||
      typeof element.x !== "number" ||
      typeof element.y !== "number" ||
      typeof element.width !== "number" ||
      typeof element.height !== "number"
    ) {
      return element;
    }
    const lines = normalizedTextLines(element.label.text);
    const measurements = lines
      .map((line) => renderedLines.get(line))
      .filter((size): size is RenderedLineSize => Boolean(size));
    if (!measurements.length) return element;

    const measuredWidth = Math.max(...measurements.map((size) => size.width));
    const measuredLineHeight = Math.max(
      ...measurements.map((size) => size.height),
    );
    const nextWidth = Math.max(
      element.width,
      Math.ceil(measuredWidth + EXCALIDRAW_LABEL_INLINE_PADDING),
    );
    const nextHeight = Math.max(
      element.height,
      Math.ceil(
        measuredLineHeight * Math.max(1, lines.length) +
          EXCALIDRAW_LABEL_BLOCK_PADDING,
      ),
    );
    if (nextWidth === element.width && nextHeight === element.height) {
      return element;
    }
    return {
      ...element,
      x: element.x - (nextWidth - element.width) / 2,
      y: element.y - (nextHeight - element.height) / 2,
      width: nextWidth,
      height: nextHeight,
    };
  });
}

async function exportSkeletons(
  skeletons: readonly MermaidSkeleton[],
  files: Parameters<typeof exportToSvg>[0]["files"],
  palette: MermaidExcalidrawPalette,
) {
  const elements = convertToExcalidrawElements(skeletons as never, {
    regenerateIds: false,
  });
  return exportToSvg({
    elements,
    files,
    exportPadding: 28,
    appState: {
      viewBackgroundColor: palette.bg,
      exportBackground: false,
      exportWithDarkMode: false,
    },
  });
}

function replacePaletteColors(
  svg: SVGSVGElement,
  palette: MermaidExcalidrawPalette,
) {
  const replacements = new Map(
    Object.entries(palette).map(([name, value]) => [
      value.toLowerCase(),
      `var(--${name})`,
    ]),
  );
  svg.querySelectorAll<SVGElement>("[stroke],[fill]").forEach((element) => {
    for (const attribute of ["stroke", "fill"] as const) {
      const value = element.getAttribute(attribute)?.toLowerCase();
      if (value && replacements.has(value)) {
        element.setAttribute(attribute, replacements.get(value)!);
      }
    }
  });
  for (const [name, value] of Object.entries(palette)) {
    svg.style.setProperty(`--${name}`, value);
  }
  svg.style.background = "var(--bg)";
  svg.style.textRendering = "geometricPrecision";
}

export async function renderExcalidrawFlow(
  source: string,
  palette: MermaidExcalidrawPalette,
) {
  const flowchart = flowchartSubgraphs(source);
  const groups = flowchart.groups;
  let skeletons: MermaidSkeleton[];
  let files: Parameters<typeof exportToSvg>[0]["files"] = null;
  let addSubgraphFrames = false;
  try {
    const parsed = await parseMermaidToExcalidraw(
      groups.length ? stripFlowchartSubgraphs(source) : source,
      {
        startOnLoad: false,
        flowchart: { curve: "basis" },
        themeVariables: { fontSize: `${EXCALIDRAW_DIAGRAM_FONT_SIZE}px` },
        maxEdges: 500,
        maxTextSize: 50_000,
      },
    );
    const parsedSkeletons = parsed.elements as unknown as MermaidSkeleton[];
    const geometrySkeletons = isSequenceDiagram(source)
      ? preserveSequenceMessageGeometry(parsedSkeletons)
      : parsedSkeletons;
    const sourceSkeletons = spaceTopLevelSubgraphs(
      geometrySkeletons,
      groups,
      flowchart.horizontal,
    );
    if (
      !sourceSkeletons.length ||
      sourceSkeletons.some((element) => element.type === "image")
    ) {
      throw new Error("Mermaid did not produce editable Excalidraw elements");
    }
    skeletons = themeMermaidSkeletons(sourceSkeletons, palette);
    addSubgraphFrames = groups.length > 0;
    files = (parsed.files || null) as Parameters<typeof exportToSvg>[0]["files"];
  } catch {
    const fallback = buildExcalidrawFlowSkeleton(source, palette);
    if (fallback === null) return null;
    skeletons = themeMermaidSkeletons(fallback, palette);
  }
  const probe = await exportSkeletons(skeletons, files, palette);
  const renderedLines = await measureRenderedText(probe);
  const fittedSkeletons = fitSkeletonsToRenderedLabels(
    skeletons,
    renderedLines,
  );
  const finalSkeletons = addSubgraphFrames
    ? [
        ...themeMermaidSkeletons(
          subgraphFrames(fittedSkeletons, groups),
          palette,
        ),
        ...fittedSkeletons,
      ]
    : fittedSkeletons;
  const svg = await exportSkeletons(finalSkeletons, files, palette);
  svg.classList.add("mermaid-excalidraw");
  svg.dataset.renderer = "excalidraw-mermaid";
  replacePaletteColors(svg, palette);
  return svg.outerHTML;
}
