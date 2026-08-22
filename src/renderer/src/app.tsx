import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Cable,
  ChevronDown,
  ChevronUp,
  Copy,
  Cpu,
  Download,
  FileDiff,
  FilePenLine,
  Files,
  FolderOpen,
  GitFork,
  KeyRound,
  Languages,
  ListChecks,
  ListRestart,
  LoaderCircle,
  MessageCircle,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Palette,
  Plus,
  RotateCcw,
  Search,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
  ShieldQuestion,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  Trash2,
  Upload,
  X,
} from "lucide-preact";
import type {
  AgentEvent,
  BackgroundEvent,
  BackgroundOutputChunk,
  BackgroundTask,
  McpServer,
  Provider,
  ProviderModel,
  RunProgress,
  SavedState,
  Settings,
  Task,
  ToolEvent,
  Turn,
  UpdateState,
} from "../../shared";
import { compactResumeToolOutput, hasContinuationState, isSoftNotFoundSource, keepCurrentDraft, latestProviderFailure, nextTaskWorkspace } from "../../shared";
import { completedMermaidBlockCount, feedScrollModeAfterScroll, finishTaskRun, nextRunnablePrompt, summarizedFailureCount, visibleWorkspaceChangeCount, type FeedScrollMode } from './task-runtime';
import { isShellTool, shellCommand } from './tool-presentation';
import logo from "./assets/shun-logo.png";

const providers: Provider[] = [
  {
    id: "remote",
    name: "Qwen Remote",
    kind: "ollama",
    endpoint: "http://100.98.225.63:11434/v1",
    apiKey: "",
    contextWindow: 65536,
    models: [{ id: "zq38:latest", contextWindow: 65536, maxOutputTokens: 8192 }],
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "ollama",
    endpoint: "http://127.0.0.1:11434/v1",
    apiKey: "",
    contextWindow: 32768,
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    kind: "lmstudio",
    endpoint: "http://127.0.0.1:1234/v1",
    apiKey: "",
    contextWindow: 32768,
  },
  {
    id: "vllm",
    name: "vLLM",
    kind: "vllm",
    endpoint: "http://127.0.0.1:8000/v1",
    apiKey: "",
    contextWindow: 32768,
  },
  {
    id: "llamacpp",
    name: "llama.cpp",
    kind: "llamacpp",
    endpoint: "http://127.0.0.1:8080/v1",
    apiKey: "",
    contextWindow: 32768,
  },
  {
    id: "custom",
    name: "Custom",
    kind: "custom",
    endpoint: "http://127.0.0.1:8000/v1",
    apiKey: "",
    contextWindow: 32768,
  },
];
const defaults: Settings = {
  endpoint: providers[0].endpoint,
  apiKey: "",
  providerId: "remote",
  providers,
  mcpServers: [],
  model: "zq38:latest",
  workspace: "",
  temperature: 0.2,
  maxTokens: 8192,
  contextWindow: providers[0].contextWindow,
  autoCompact: true,
  permission: "ask",
  language: "system",
  theme: "system",
  accent: "blue",
};
const uid = () => crypto.randomUUID(),
  makeTask = (workspace = ""): Task => ({
    id: uid(),
    title: "New task",
    workspace,
    turns: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }),
  hasTaskMessages = (task: Task) =>
    task.turns.some((turn) => Boolean(turn.content?.trim())),
  first = makeTask();

function normalizeProviderModels(provider: Provider, fallbackWindow: number): ProviderModel[] {
  const raw = Array.isArray(provider.models) ? (provider.models as unknown[]) : [];
  return raw
    .map((item) =>
      typeof item === "string"
        ? { id: item, contextWindow: provider.contextWindow || fallbackWindow, maxOutputTokens: 8192 }
        : item && typeof item === "object" && "id" in item
          ? {
              id: String((item as ProviderModel).id),
              name: (item as ProviderModel).name,
              contextWindow: Number((item as ProviderModel).contextWindow) || provider.contextWindow || fallbackWindow,
              maxOutputTokens: Number((item as ProviderModel).maxOutputTokens) || 8192,
              enabled: (item as ProviderModel).enabled,
            }
          : null,
    )
    .filter((item): item is ProviderModel => Boolean(item?.id));
}

function resolveUiLanguage(value: Settings["language"]): UiLanguage {
  if (value === "zh-CN") return "zh";
  if (value === "en") return "en";
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function resolvedTheme(value: Settings["theme"]) {
  return value === "light" || value === "dark"
    ? value
    : matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
}

function syncMermaidTheme(theme: "light" | "dark", accent: Settings["accent"]) {
  const accentColor = accent === "violet" ? "#8b6ee8" : accent === "orange" ? "#d87943" : "#5277d9";
  const colors = theme === "light"
    ? { bg: "#ffffff", fg: "#1e1e1e", line: "#1e1e1e", muted: "#868e96", surface: "transparent", border: "#bbbbbb" }
    : { bg: "#101113", fg: "#e9ecef", line: "#e9ecef", muted: "#9aa0aa", surface: "transparent", border: "#7a7a7a" };
  document.querySelectorAll<SVGElement>(".mermaid-view svg,.diagram-modal-stage svg").forEach((svg) => {
    for (const [key, value] of Object.entries({ ...colors, accent: accentColor })) svg.style.setProperty(`--${key}`, value);
    svg.style.background = "var(--bg)";
  });
}
const commands = [
  { name: "/model", detail: "Choose model" },
  { name: "/compact", detail: "Compact context", args: true },
  { name: "/fork", detail: "Fork from last response" },
  { name: "/name", detail: "Rename task", args: true },
  { name: "/copy", detail: "Copy last response" },
  { name: "/export", detail: "Export task" },
  { name: "/import", detail: "Import task" },
  { name: "/clear", detail: "Clear task" },
  { name: "/new", detail: "New task" },
  { name: "/settings", detail: "Open settings" },
];
const markdown = new Marked(
  markedHighlight({
    emptyLangClass: "hljs",
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    },
  }),
);
let mermaidClient: Promise<typeof import("./mermaid/svg.js")> | undefined;
let excalidrawMermaidClient:
  | Promise<typeof import("./mermaid/excalidraw-flow")>
  | undefined;
type MermaidRenderCacheEntry = {
  svg?: string;
  promise: Promise<string>;
};
const mermaidRenderCache = new Map<string, MermaidRenderCacheEntry>();

function cachedMermaidRender(source: string) {
  const appearance = `${document.documentElement.dataset.theme || "dark"}:${document.documentElement.dataset.accent || "blue"}`;
  const key = `${appearance}\u0000${normalizeMermaid(source)}`;
  const cached = mermaidRenderCache.get(key);
  if (cached) return cached;
  const entry = {} as MermaidRenderCacheEntry;
  entry.promise = renderMermaid(source)
    .then((svg) => {
      entry.svg = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
      });
      return entry.svg;
    })
    .catch((error) => {
      mermaidRenderCache.delete(key);
      throw error;
    });
  mermaidRenderCache.set(key, entry);
  if (mermaidRenderCache.size > 32) {
    const oldest = mermaidRenderCache.keys().next().value;
    if (oldest) mermaidRenderCache.delete(oldest);
  }
  return entry;
}
type UiLanguage = "zh" | "en";

function taskLanguage(turns: Turn[]): UiLanguage {
  const text =
    turns.find((turn) => turn.role === "user" && turn.content.trim())
      ?.content || "";
  const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length,
    latin = (text.match(/[A-Za-z]/g) || []).length;
  return chinese >= 2 && chinese >= latin * 0.12 ? "zh" : "en";
}

export function App() {
  const [settings, setSettings] = useState(defaults),
    [tasks, setTasks] = useState<Task[]>([first]),
    [currentId, setCurrentId] = useState(first.id),
    [draftByTask, setDraftByTask] = useState<Record<string, string>>({}),
    [runningByTask, setRunningByTask] = useState<Record<string, string>>({}),
    [clock, setClock] = useState(Date.now()),
    [queued, setQueued] = useState<
      { id: string; taskId: string; text: string }[]
    >([]),
    [backgroundByTask, setBackgroundByTask] = useState<Record<string, BackgroundTask[]>>({}),
    [backgroundOutput, setBackgroundOutput] = useState<Record<string, BackgroundOutputChunk[]>>({}),
    [models, setModels] = useState<string[]>([]),
    [searching, setSearching] = useState(false),
    [query, setQuery] = useState(""),
    [searchIndex, setSearchIndex] = useState(0),
    [showArchived, setShowArchived] = useState(false),
    [itemMenu, setItemMenu] = useState(""),
    [taskMenuDirection, setTaskMenuDirection] = useState<"up" | "down">("up"),
    [renameTarget, setRenameTarget] = useState<{ id: string; value: string } | null>(null),
    [confirmAction, setConfirmAction] = useState<{
      title: string;
      body: string;
      label: string;
      action: () => void;
    } | null>(null),
    [showSettings, setShowSettings] = useState(false),
    [appUpdate, setAppUpdate] = useState<UpdateState | null>(null),
    [showBackgrounds, setShowBackgrounds] = useState(false),
    [diff, setDiff] = useState<string | null>(null),
    [workspaceReviews, setWorkspaceReviews] = useState<Record<string, { text: string; count: number }>>({}),
    [permissionMenu, setPermissionMenu] = useState(false),
    [modelMenu, setModelMenu] = useState(false),
    [projectMenu, setProjectMenu] = useState(false),
    [projectQuery, setProjectQuery] = useState(""),
    [slashDismissed, setSlashDismissed] = useState(false),
    [sidebarOpen, setSidebarOpen] = useState(true),
    [collapsedWorkspaces, setCollapsedWorkspaces] = useState<string[]>([]),
    [hydrated, setHydrated] = useState(false),
    feed = useRef<HTMLDivElement>(null),
    feedScrollMode = useRef<FeedScrollMode>('follow-bottom'),
    lockedFeedScrollTop = useRef<number | null>(null),
    programmaticScrollTop = useRef<number | null>(null),
    input = useRef<HTMLTextAreaElement>(null),
    searchInput = useRef<HTMLInputElement>(null),
    pendingScrollTurn = useRef(""),
    deltas = useRef(new Map<string, string>()),
    titleFallbacks = useRef(new Map<string, { taskId: string; title: string }>()),
    frame = useRef(0);
  const task = tasks.find((x) => x.id === currentId) || tasks[0],
    text = draftByTask[currentId] || "",
    running = runningByTask[currentId] || "",
    backgrounds = backgroundByTask[currentId] || [],
    allBackgrounds = Object.values(backgroundByTask).flat().sort((a, b) => b.createdAt - a.createdAt),
    activeBackgroundCount = allBackgrounds.filter((item) => ['starting', 'running', 'stopping'].includes(item.state)).length,
    hasActiveBackground = activeBackgroundCount > 0,
    turns = task?.turns || [],
    language = taskLanguage(turns),
    uiLanguage = resolveUiLanguage(settings.language),
    zh = uiLanguage === "zh",
    workspace = task?.workspace.split("/").pop() || (zh ? "选择项目" : "Choose project"),
    knownWorkspaces = [
      ...new Set(
        tasks
          .filter((x) => x.workspace && !x.archivedAt)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((x) => x.workspace),
      ),
    ],
    matchingWorkspaces = knownWorkspaces.filter((path) =>
      path.toLowerCase().includes(projectQuery.trim().toLowerCase()),
    ),
    provider =
      settings.providers.find((x) => x.id === settings.providerId) ||
      settings.providers[0],
    history = turns
      .filter((x) => x.content)
      .map(({ role, content }) => ({ role, content })),
    needle = query.trim().toLowerCase(),
    visible = tasks
      .filter(hasTaskMessages)
      .filter((x) => Boolean(x.archivedAt) === showArchived)
      .sort((a, b) => b.updatedAt - a.updatedAt),
    searchMatches = tasks
      .filter(hasTaskMessages)
      .filter(
        (x) =>
          !needle ||
          `${x.title} ${x.workspace}`.toLowerCase().includes(needle),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 9),
    groups = taskGroups(visible),
    changes = useMemo(() => changedFiles(turns), [turns]),
    workspaceReviewKey = task?.workspace
      ? JSON.stringify([currentId, task.workspace])
      : "",
    workspaceReview = workspaceReviewKey
      ? workspaceReviews[workspaceReviewKey]
      : undefined,
    changeCount = visibleWorkspaceChangeCount(
      task?.workspace,
      workspaceReview?.count,
      changes.length,
    ),
    activeContext = [...turns]
      .reverse()
      .find((x) => x.contextUsage)?.contextUsage,
    activeProgress = [...turns].reverse().find((x) => x.progress)?.progress,
    usedTokens = Math.ceil((activeContext?.usedCharacters || 0) / 2),
    contextPercent = activeContext
      ? Math.min(
          100,
          Math.round(
            (activeContext.usedCharacters /
              Math.max(1, activeContext.budgetCharacters)) *
              100,
          ),
        )
      : 0,
    matchingCommands =
      !slashDismissed && text.startsWith("/") && !text.includes("\n")
        ? commands
            .filter((x) => x.name.startsWith(text.split(" ")[0]))
            .slice(0, 7)
        : [];
  useEffect(() => {
    window.shun.load().then((saved: SavedState | null) => {
      if (saved?.settings && Array.isArray(saved.tasks)) {
        const restored = saved.tasks.map((task) => ({
            ...task,
            turns: task.turns.map((turn) => normalizeRestoredTurn(turn)),
          })).filter(hasTaskMessages),
          tasks = restored.length ? restored : [makeTask(saved.settings.workspace || "")],
          selected = tasks.find((x) => x.id === saved.currentId) || tasks[0],
          bootstrap =
            saved.settings.endpoint === "http://127.0.0.1:11434/v1" &&
            saved.settings.model === "zq38:latest",
          configured = bootstrap
            ? {
                ...saved.settings,
                endpoint: defaults.endpoint,
                providerId: defaults.providerId,
                model: defaults.model,
              }
            : saved.settings,
          savedContext =
            Number(configured.contextWindow) || defaults.contextWindow,
          custom = (configured.providers || [])
            .filter(
              (item) => !providers.some((preset) => preset.id === item.id),
            )
            .map((item) => ({
              ...item,
              contextWindow: Number(item.contextWindow) || savedContext,
              models: normalizeProviderModels(item, savedContext),
            })),
          merged = [
            ...providers.map((preset) => {
              const savedProvider = configured.providers?.find(
                  (item) => item.id === preset.id,
                ),
                savedWindow = Number(savedProvider?.contextWindow);
              return {
                ...preset,
                ...(savedProvider || {}),
                contextWindow:
                  preset.id === "remote" && savedWindow === 32768
                    ? 65536
                    : savedWindow || savedContext,
                models: normalizeProviderModels(
                  { ...preset, ...(savedProvider || {}) },
                  savedWindow || savedContext,
                ),
              };
            }),
            ...custom,
          ],
          active =
            merged.find((item) => item.id === configured.providerId) ||
            merged[0];
        setSettings({
          ...defaults,
          ...configured,
          endpoint: active.endpoint,
          apiKey: active.apiKey,
          providerId: active.id,
          contextWindow: active.contextWindow,
          providers: merged,
          mcpServers: Array.isArray(configured.mcpServers)
            ? configured.mcpServers.filter((item) => item && typeof item.url === "string").map((item) => ({
                id: String(item.id || uid()),
                name: String(item.name || "MCP server"),
                url: String(item.url),
                enabled: item.enabled !== false,
              }))
            : [],
        });
        setTasks(tasks);
        setCurrentId(selected.id);
        setShowArchived(Boolean(selected.archivedAt));
      }
      setHydrated(true);
    });
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    const timer = setTimeout(
      () => window.shun.save(stateForStorage(settings, tasks, currentId)),
      500,
    );
    return () => clearTimeout(timer);
  }, [hydrated, settings, tasks, currentId]);
  useEffect(() => {
    if (hydrated && currentId) window.shun.selectTask(currentId);
  }, [hydrated, currentId]);
  useEffect(() => {
    let live = true,
      probe = () =>
        window.shun
          .models(settings.endpoint, settings.apiKey)
          .then((x) => live && setModels(x));
    probe();
    const timer = setInterval(probe, 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [settings.endpoint, settings.apiKey]);
  useEffect(() => {
    if (!models.length) return;
    setSettings((x) => {
      const active = x.providers.find((item) => item.id === x.providerId) || x.providers[0],
        configured = normalizeProviderModels(active, x.contextWindow),
        merged = [
          ...models.map((id) => configured.find((item) => item.id === id) || {
            id,
            contextWindow: active.contextWindow || x.contextWindow,
            maxOutputTokens: x.maxTokens || 8192,
          }),
          ...configured.filter((item) => !models.includes(item.id)),
        ],
        sameModels = configured.length === merged.length && configured.every((item, index) =>
          item.id === merged[index].id && item.contextWindow === merged[index].contextWindow && item.maxOutputTokens === merged[index].maxOutputTokens,
        ),
        selectedId = merged.some((item) => item.id === x.model)
          ? x.model
          : merged.find((item) => item.id === "qwen3.5:latest")?.id ||
            merged.find((item) => /qwen/i.test(item.id))?.id ||
            merged[0].id,
        selected = merged.find((item) => item.id === selectedId)!;
      if (sameModels && selectedId === x.model && selected.contextWindow === x.contextWindow && selected.maxOutputTokens === x.maxTokens) return x;
      return {
        ...x,
        model: selectedId,
        contextWindow: selected.contextWindow,
        maxTokens: selected.maxOutputTokens,
        providers: x.providers.map((item) => item.id === active.id ? { ...item, models: merged } : item),
      };
    });
  }, [models]);
  useEffect(() => {
    const apply = () => {
      const theme = resolvedTheme(settings.theme);
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.accent = settings.accent || "blue";
      document.documentElement.lang = resolveUiLanguage(settings.language) === "zh" ? "zh-CN" : "en";
      syncMermaidTheme(theme, settings.accent);
    };
    apply();
    const media = matchMedia("(prefers-color-scheme: light)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.theme, settings.accent, settings.language]);
  useEffect(() => window.shun.onEvent(onEvent), []);
  useEffect(() => window.shun.onBackgroundEvent(onBackgroundEvent), []);
  useEffect(() => window.shun.onSettings(() => setShowSettings(true)), []);
  useEffect(() => {
    let live = true;
    window.shun.updateState().then((state) => live && setAppUpdate(state));
    const unsubscribe = window.shun.onUpdate((state) => live && setAppUpdate(state));
    return () => { live = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!hydrated || !task?.workspace || running) return;
    let live = true;
    const timer = setTimeout(() => {
      window.shun.diff(task.id, task.workspace, changes, changedDiffs(turns)).then((text) => {
        if (live) {
          const key = JSON.stringify([task.id, task.workspace]);
          setWorkspaceReviews((reviews) => ({ ...reviews, [key]: { text, count: splitDiff(text).length } }));
        }
      });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [hydrated, currentId, task?.workspace, task?.updatedAt, running]);
  useEffect(() => {
    let live = true;
    window.shun.backgroundListAll().then((items) => {
      if (!live) return;
      const grouped: Record<string, BackgroundTask[]> = {};
      for (const item of items) (grouped[item.sessionId] ||= []).push(item);
      setBackgroundByTask(grouped);
      for (const item of items) window.shun.backgroundOutput(item.sessionId, item.id).then((chunks) => {
        if (live) setBackgroundOutput((all) => ({ ...all, [item.id]: chunks.slice(-40) }));
      });
    });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    const node = feed.current;
    if (!node) return;
    const pending = pendingScrollTurn.current;
    const id = requestAnimationFrame(() => {
      if (pending) {
        const anchor = node.querySelector<HTMLElement>(`[data-turn-id="${pending}"]`);
        if (anchor) {
          const feedTop = node.getBoundingClientRect().top,
            anchorTop = anchor.getBoundingClientRect().top,
            target = Math.max(0, node.scrollTop + anchorTop - feedTop - 22);
          programmaticScrollTop.current = target;
          node.scrollTop = target;
          programmaticScrollTop.current = node.scrollTop;
          lockedFeedScrollTop.current = node.scrollTop;
          pendingScrollTurn.current = "";
          feedScrollMode.current = 'locked-turn';
        }
      } else if (
        feedScrollMode.current === 'locked-turn' &&
        lockedFeedScrollTop.current !== null
      ) {
        const target = lockedFeedScrollTop.current;
        if (Math.abs(node.scrollTop - target) >= 1) {
          programmaticScrollTop.current = target;
          node.scrollTop = target;
          programmaticScrollTop.current = node.scrollTop;
        }
      } else if (feedScrollMode.current === 'follow-bottom') {
        programmaticScrollTop.current = node.scrollHeight;
        node.scrollTop = node.scrollHeight;
        programmaticScrollTop.current = node.scrollTop;
      }
    });
    return () => cancelAnimationFrame(id);
  }, [turns]);
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = "auto";
    input.current.style.height = `${Math.min(input.current.scrollHeight, 190)}px`;
  }, [text]);
  useEffect(() => {
    if (!running && !hasActiveBackground) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, hasActiveBackground]);
  useEffect(() => setSlashDismissed(false), [text]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newTask();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearching(true);
        setSearchIndex(0);
        requestAnimationFrame(() => searchInput.current?.focus());
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setShowSettings(true);
      }
      if (e.key === "Escape") {
        setSearching(false);
        setQuery("");
        setDiff(null);
        setShowSettings(false);
        setShowBackgrounds(false);
        setPermissionMenu(false);
        setModelMenu(false);
        setProjectMenu(false);
        setRenameTarget(null);
        setSlashDismissed(true);
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [running, currentId]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!target.closest(".project-menu,.project-trigger,.crumb:not(.locked)"))
        setProjectMenu(false);
      if (!target.closest(".item-menu,.item-menu-trigger")) setItemMenu("");
      if (!target.closest(".permission-picker,.bar .access"))
        setPermissionMenu(false);
      if (!target.closest(".model-picker,.model-btn")) setModelMenu(false);
      if (!target.closest(".slash-menu,.composer textarea"))
        setSlashDismissed(true);
    };
    addEventListener("pointerdown", dismiss);
    return () => removeEventListener("pointerdown", dismiss);
  }, []);
  useEffect(() => {
    const next = nextRunnablePrompt(queued, runningByTask);
    if (!next) return;
    const target = tasks.find((x) => x.id === next.taskId);
    setQueued((items) => items.filter((item) => item.id !== next.id));
    if (target) runPrompt(next.text, target.turns, target);
  }, [runningByTask, queued, tasks]);
  function update(id: string, fn: (task: Task) => Task) {
    setTasks((xs) => xs.map((x) => (x.id === id ? fn(x) : x)));
  }
  function setText(value: string, taskId = currentId) {
    setDraftByTask((drafts) => {
      if (value) return { ...drafts, [taskId]: value };
      if (!(taskId in drafts)) return drafts;
      const next = { ...drafts };
      delete next[taskId];
      return next;
    });
  }
  function onEvent(event: AgentEvent) {
    if (event.type === "title") {
      const pending = titleFallbacks.current.get(event.id),
        title = (event.text || "").trim();
      if (pending && title)
        setTasks((items) =>
          items.map((item) =>
            item.id === pending.taskId && item.title === pending.title
              ? { ...item, title, updatedAt: Date.now() }
              : item,
          ),
        );
      return;
    }
    if (event.type === "delta") {
      deltas.current.set(
        event.id,
        (deltas.current.get(event.id) || "") + (event.text || ""),
      );
      if (!frame.current)
        frame.current = requestAnimationFrame(() => {
          const pending = new Map(deltas.current);
          deltas.current.clear();
          frame.current = 0;
          setTasks((xs) => applyPending(xs, pending));
        });
      return;
    }
    if (
      event.type === "done" ||
      event.type === "cancelled" ||
      event.type === "error"
    ) {
      titleFallbacks.current.delete(event.id);
      setRunningByTask((active) => finishTaskRun(active, event.id));
    }
    const pending = new Map(deltas.current);
    deltas.current.clear();
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    setTasks((xs) =>
      applyPending(xs, pending).map((task) =>
        !task.turns.some((x) => x.id === event.id)
          ? task
          : event.type === "compacted"
            ? {
                ...task,
                summary: event.text,
                compactedAt: Math.max(0, task.turns.length - 8),
                updatedAt: Date.now(),
              }
            : {
                ...task,
                updatedAt: Date.now(),
                turns: task.turns.map((x) =>
                  x.id === event.id ? applyEvent(x, event) : x,
                ),
              },
      ),
    );
  }
  function onBackgroundEvent(event: BackgroundEvent) {
    setBackgroundByTask((all) => {
      const items = all[event.task.sessionId] || [];
      const next = items.some((item) => item.id === event.task.id)
        ? items.map((item) => item.id === event.task.id ? event.task : item)
        : [event.task, ...items];
      return { ...all, [event.task.sessionId]: next };
    });
    if (event.type === 'output' && event.chunk) setBackgroundOutput((all) => ({
      ...all,
      [event.task.id]: [...(all[event.task.id] || []), event.chunk!].slice(-40),
    }));
  }
  function newTask(workspace?: string) {
    const next = makeTask(nextTaskWorkspace(workspace, task?.workspace, settings.workspace));
    setTasks((xs) => [next, ...xs.filter(hasTaskMessages)]);
    setCurrentId(next.id);
    setShowArchived(false);
    setProjectMenu(false);
    setItemMenu("");
    feedScrollMode.current = 'follow-bottom';
    lockedFeedScrollTop.current = null;
    pendingScrollTurn.current = "";
    setTimeout(() => input.current?.focus());
  }
  function selectTask(next: Task) {
    setTasks((items) => items.filter((item) => item.id === next.id || hasTaskMessages(item)));
    setCurrentId(next.id);
    setShowArchived(Boolean(next.archivedAt));
    setSearching(false);
    setItemMenu("");
    setSettings((value) => ({ ...value, workspace: next.workspace }));
    feedScrollMode.current = 'follow-bottom';
    lockedFeedScrollTop.current = null;
    pendingScrollTurn.current = "";
  }
  function isRunning(item: Task) {
    return Boolean(runningByTask[item.id]) || (backgroundByTask[item.id] || []).some((process) => ['starting', 'running', 'stopping'].includes(process.state));
  }
  function commitTasks(next: Task[]) {
    if (!next.length) next = [makeTask(settings.workspace || "")];
    setTasks(next);
    const ids = new Set(next.map((task) => task.id));
    setDraftByTask((drafts) => Object.fromEntries(Object.entries(drafts).filter(([id]) => ids.has(id))));
    setRunningByTask((runs) => Object.fromEntries(Object.entries(runs).filter(([id]) => ids.has(id))));
    setBackgroundByTask((processes) => Object.fromEntries(Object.entries(processes).filter(([id]) => ids.has(id))));
    setQueued((queue) =>
      queue.filter((item) => next.some((task) => task.id === item.taskId)),
    );
    const selected =
      next.find(
        (x) => x.id === currentId && Boolean(x.archivedAt) === showArchived,
      ) ||
      next.find((x) => Boolean(x.archivedAt) === showArchived) ||
      next[0];
    if (selected) {
      setCurrentId(selected.id);
      setShowArchived(Boolean(selected.archivedAt));
    } else setCurrentId("");
    setItemMenu("");
  }
  function archiveTask(id: string, archived: boolean) {
    const item = tasks.find((x) => x.id === id);
    if (!item || isRunning(item)) return;
    commitTasks(
      tasks.map((x) =>
        x.id === id
          ? {
              ...x,
              archivedAt: archived ? Date.now() : undefined,
              updatedAt: Date.now(),
            }
          : x,
      ),
    );
  }
  function deleteTask(id: string) {
    const item = tasks.find((x) => x.id === id);
    if (!item || isRunning(item)) return;
    setConfirmAction({
      title: "Delete task?",
      body: `“${item.title}” will be removed from Shun. Files in ${item.workspace || "the filesystem"} will not be deleted.`,
      label: "Delete task",
      action: () => commitTasks(tasks.filter((x) => x.id !== id)),
    });
  }
  function beginRename(item: Task) {
    setItemMenu("");
    setRenameTarget({ id: item.id, value: item.title });
  }
  function commitRename() {
    if (!renameTarget) return;
    const title = renameTarget.value.trim();
    if (title)
      update(renameTarget.id, (item) => ({
        ...item,
        title: title.slice(0, 120),
        updatedAt: Date.now(),
      }));
    setRenameTarget(null);
  }
  function archiveProject(workspace: string, archived: boolean) {
    const members = tasks.filter((x) => x.workspace === workspace);
    if (!members.length || members.some(isRunning)) return;
    commitTasks(
      tasks.map((x) =>
        x.workspace === workspace
          ? {
              ...x,
              archivedAt: archived ? Date.now() : undefined,
              updatedAt: Date.now(),
            }
          : x,
      ),
    );
  }
  function deleteProject(workspace: string) {
    const members = tasks.filter((x) => x.workspace === workspace);
    if (!members.length || members.some(isRunning)) return;
    const name = workspace.split("/").pop();
    setConfirmAction({
      title: `Delete ${name} from Shun?`,
      body: `This removes ${members.length} task record${members.length === 1 ? "" : "s"} from Shun. The project folder and every file on disk remain untouched.`,
      label: "Delete project records",
      action: () => commitTasks(tasks.filter((x) => x.workspace !== workspace)),
    });
  }
  function setDraftWorkspace(path: string) {
    if (turns.length) return;
    setSettings((x) => ({ ...x, workspace: path }));
    update(currentId, (x) => ({
      ...x,
      workspace: path,
      updatedAt: Date.now(),
    }));
    setProjectMenu(false);
    setProjectQuery("");
  }
  function detachWorkspace() {
    if (!task?.workspace) return;
    setSettings((value) => ({ ...value, workspace: "" }));
    update(currentId, (item) => ({
      ...item,
      workspace: "",
      updatedAt: Date.now(),
    }));
    setProjectMenu(false);
    setProjectQuery("");
  }
  async function chooseWorkspace() {
    if (turns.length) return;
    const path = await window.shun.chooseWorkspace();
    if (path) setDraftWorkspace(path);
  }
  function runPrompt(
    prompt: string,
    base = turns,
    target = task,
    replay?: { history: Turn[]; evidence: Turn[] },
  ) {
    if (!prompt.trim() || runningByTask[target?.id || ""] || !target) return;
    const generateTitle = !replay && target.title === "New task" && !base.some((turn) => turn.role === "user"),
      fallbackTitle = prompt.trim().replace(/\s+/g, " ").slice(0, 46),
      runId = uid(),
      now = Date.now(),
      userId = replay ? "" : uid(),
      conversation = replay?.history || base,
      evidence = replay?.evidence || base,
      next: Turn[] = replay
        ? [
            ...base,
            {
              id: runId,
              role: "assistant",
              content: "",
              phase: "Thinking",
              startedAt: now,
              lastActivityAt: now,
              lastProgressAt: now,
            },
          ]
        : [
            ...base,
            { id: userId, role: "user", content: prompt.trim() },
            {
              id: runId,
              role: "assistant",
              content: "",
              phase: "Thinking",
              startedAt: now,
              lastActivityAt: now,
              lastProgressAt: now,
            },
          ];
    if (generateTitle)
      titleFallbacks.current.set(runId, { taskId: target.id, title: fallbackTitle });
    if (target.id === currentId) {
      feedScrollMode.current = replay ? 'follow-bottom' : 'locked-turn';
      lockedFeedScrollTop.current = null;
      pendingScrollTurn.current = userId;
    }
    update(target.id, (x) => ({
      ...x,
      title:
        generateTitle && x.title === "New task"
          ? fallbackTitle
          : x.title,
      turns: next,
      updatedAt: Date.now(),
    }));
    if (target.id === currentId) setText("");
    setRunningByTask((active) => ({ ...active, [target.id]: runId }));
    window.shun.run({
      id: runId,
      taskId: target.id,
      text: prompt.trim(),
      history: conversation
        .filter((x) => x.content)
        .map(({ role, content }) => ({ role, content })),
      settings: { ...settings, workspace: target.workspace },
      ...(generateTitle ? { generateTitle: true } : {}),
      summary: target.summary,
      compactedAt: target.compactedAt,
      web: webHistory(evidence),
      ...(replay || hasContinuationState(evidence)
        ? { resume: { ...resumeHistory(evidence), intent: replay ? "retry" as const : "followup" as const } }
        : {}),
    });
  }
  function submit() {
    const prompt = text.trim();
    if (!prompt) return;
    if (prompt === "/settings") {
      setShowSettings(true);
      setText("");
      return;
    }
    if (prompt === "/model") {
      setModelMenu(true);
      setText("");
      return;
    }
    if (prompt === "/new") {
      newTask();
      return;
    }
    if (prompt.startsWith("/name ")) {
      update(currentId, (x) => ({
        ...x,
        title: prompt.slice(6).trim() || x.title,
        updatedAt: Date.now(),
      }));
      setText("");
      return;
    }
    if (prompt.startsWith("/compact")) {
      setText("");
      void compact(prompt.slice(8).trim());
      return;
    }
    if (prompt === "/copy") {
      const last = [...turns]
        .reverse()
        .find((x) => x.role === "assistant" && x.content);
      if (last) navigator.clipboard.writeText(last.content);
      setText("");
      return;
    }
    if (prompt === "/fork") {
      const last = [...turns].reverse().find((x) => x.role === "assistant");
      if (last) fork(last.id);
      setText("");
      return;
    }
    if (prompt === "/export") {
      setText("");
      void exportTask();
      return;
    }
    if (prompt === "/import") {
      setText("");
      void importTask();
      return;
    }
    if (prompt === "/clear" && !running) {
      update(currentId, (x) => ({
        ...x,
        turns: [],
        summary: undefined,
        compactedAt: undefined,
        updatedAt: Date.now(),
      }));
      setText("");
      return;
    }
    if (running) {
      setQueued((x) => [...x, { id: uid(), taskId: currentId, text: prompt }]);
      setText("");
      return;
    }
    runPrompt(prompt);
  }
  async function compact(instructions = "") {
    if (running || turns.length < 2) return;
    const summary = await window.shun.compact(
      {
        id: uid(),
        taskId: task.id,
        text: "",
        history,
        settings: { ...settings, workspace: task.workspace },
      },
      instructions,
    );
    if (summary)
      update(currentId, (x) => ({
        ...x,
        summary,
        compactedAt: x.turns.length,
        updatedAt: Date.now(),
      }));
  }
  function retry(id: string) {
    const index = turns.findIndex((x) => x.id === id),
      userIndex = turns.findLastIndex((x, i) => i < index && x.role === "user"),
      user = turns[userIndex];
    if (index >= 0 && user)
      runPrompt(user.content, turns, task, {
        history: turns.slice(0, userIndex),
        evidence: turns.slice(0, index + 1),
      });
  }
  function fork(id: string) {
    const index = turns.findIndex((x) => x.id === id);
    if (index < 0) return;
    const next: Task = {
      ...makeTask(task.workspace),
      title: `${task.title} · fork`,
      turns: turns
        .slice(0, index + 1)
        .map((x) => ({ ...x, tools: turnTools(x).map((y) => ({ ...y })) })),
    };
    setTasks((x) => [next, ...x]);
    setCurrentId(next.id);
  }
  async function exportTask() {
    if (task) await window.shun.exportTask(task);
  }
  async function importTask() {
    const next = await window.shun.importTask();
    if (!next) return;
    setTasks((x) => [next, ...x]);
    setCurrentId(next.id);
    setShowSettings(false);
  }
  async function review() {
    if (!task?.workspace) return;
    const text = await window.shun.diff(task.id, task.workspace, changes, changedDiffs(turns));
    const key = JSON.stringify([task.id, task.workspace]);
    setWorkspaceReviews((reviews) => ({ ...reviews, [key]: { text, count: splitDiff(text).length } }));
    setDiff(text);
  }
  function activateUpdate() {
    if (!appUpdate) return;
    if (appUpdate.status === "available") void window.shun.downloadUpdate();
    else if (appUpdate.status === "ready") void window.shun.installUpdate();
    else if (appUpdate.status === "error") void window.shun.checkForUpdate();
  }
  const showUpdate = appUpdate && (
    appUpdate.status === "available" ||
    appUpdate.status === "downloading" ||
    appUpdate.status === "ready" ||
    (appUpdate.status === "error" && appUpdate.targetVersion)
  );
  return (
    <main class={`shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <aside class="sidebar">
        <button
          class="sidebar-toggle"
          aria-label="Hide sidebar"
          title="Hide sidebar"
          onClick={() => setSidebarOpen(false)}
        >
          <PanelLeftClose />
        </button>
        <div class="brand">
          <BrandMark />
          <span>Shun</span>
          {showUpdate && <button
            class={`sidebar-update ${appUpdate.status}`}
            disabled={appUpdate.status === "downloading"}
            aria-label={appUpdate.status === "ready" ? (zh ? "重启并安装更新" : "Restart and install update") : (zh ? "更新 Shun" : "Update Shun")}
            title={appUpdate.message || (appUpdate.targetVersion ? `${zh ? "新版本" : "Version"} ${appUpdate.targetVersion}` : undefined)}
            onClick={activateUpdate}
          >
            {appUpdate.status === "downloading" ? <LoaderCircle class="task-spinner" /> : <Download />}
            <span>{appUpdate.status === "downloading"
              ? `${appUpdate.percent || 0}%`
              : appUpdate.status === "ready"
                ? (zh ? "重启升级" : "Restart")
                : appUpdate.status === "error"
                  ? (zh ? "重试" : "Retry")
                  : (zh ? "升级" : "Update")}</span>
          </button>}
        </div>
        <button class="new" onClick={() => newTask()}>
          <Plus />
          <span>{zh ? "新建任务" : "New task"}</span>
          <kbd>
            <span class="shortcut-mod">⌘</span>
            <span class="shortcut-key">N</span>
          </kbd>
        </button>
        <div class="nav">
          <button
            onClick={() => {
              setSearching(true);
              setSearchIndex(0);
            }}
          >
            <Search />
            <span>{zh ? "搜索" : "Search"}</span>
            <kbd>
              <span class="shortcut-mod">⌘</span>
              <span class="shortcut-key">K</span>
            </kbd>
          </button>
          <button
            class={showArchived ? "active" : ""}
            onClick={() => {
              setShowArchived((x) => !x);
              setItemMenu("");
            }}
          >
            <Archive />
            <span>{showArchived ? (zh ? "返回任务" : "Back to tasks") : (zh ? "已归档" : "Archived")}</span>
          </button>
        </div>
        <div class="tasks task-tree">
          {showArchived && (
            <div class="archive-heading">
              <Archive />
              <span>{zh ? "已归档" : "Archived"}</span>
            </div>
          )}
          {groups.map((group) => (
            <section
              class={`workspace-group ${group.workspace ? "" : "loose"}`}
              key={group.workspace || "recents"}
            >
              {group.workspace ? (
                <div
                  class={`workspace-head ${collapsedWorkspaces.includes(group.workspace) ? "collapsed" : ""}`}
                  title={group.workspace}
                  role="button"
                  tabIndex={0}
                  aria-expanded={!collapsedWorkspaces.includes(group.workspace)}
                  onClick={(event) => {
                    if ((event.target as Element).closest(".workspace-controls")) return;
                    setCollapsedWorkspaces((items) =>
                      items.includes(group.workspace)
                        ? items.filter((item) => item !== group.workspace)
                        : [...items, group.workspace],
                    );
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") event.currentTarget.click();
                  }}
                >
                  <FolderOpen />
                  <span>{group.workspace.split("/").pop()}</span>
                  <div class="workspace-controls">
                    {!showArchived && (
                      <button
                        title={`New task in ${group.workspace.split("/").pop()}`}
                        onClick={() => newTask(group.workspace)}
                      >
                        <Plus />
                      </button>
                    )}
                    <button
                      class="item-menu-trigger"
                      aria-label="Project actions"
                      aria-expanded={itemMenu === `project:${group.workspace}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setItemMenu(
                          itemMenu === `project:${group.workspace}`
                            ? ""
                            : `project:${group.workspace}`,
                        );
                      }}
                    >
                      <MoreHorizontal />
                    </button>
                    {itemMenu === `project:${group.workspace}` && (
                      <div class="item-menu project-actions">
                        <button
                          onClick={() => {
                            setItemMenu("");
                            void window.shun.openWorkspace(group.workspace);
                          }}
                        >
                          <FolderOpen />
                          {navigator.platform.includes("Mac") ? "Show in Finder" : "Open folder"}
                        </button>
                        {showArchived ? (
                          <button
                            onClick={() =>
                              archiveProject(group.workspace, false)
                            }
                          >
                            <ArchiveRestore />
                            Restore project
                          </button>
                        ) : (
                          <button
                            onClick={() =>
                              archiveProject(group.workspace, true)
                            }
                            disabled={group.tasks.some(isRunning)}
                          >
                            <Archive />
                            Archive project
                          </button>
                        )}
                        <button
                          class="danger"
                          onClick={() => deleteProject(group.workspace)}
                          disabled={tasks
                            .filter((x) => x.workspace === group.workspace)
                            .some(isRunning)}
                        >
                          <Trash2 />
                          Delete project
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div class="workspace-label">
                  {showArchived ? (zh ? "归档任务" : "ARCHIVED TASKS") : (zh ? "最近任务" : "RECENTS")}
                </div>
              )}
              <div class={`workspace-tasks ${group.workspace && collapsedWorkspaces.includes(group.workspace) ? "collapsed" : ""}`}>
                {group.tasks.map((item) => (
                  <div class="task-row" key={item.id}>
                    <button
                      class={`task ${item.id === currentId ? "active" : ""}`}
                      onClick={() => selectTask(item)}
                    >
                      <span class="task-title">{zh && item.title === "New task" ? "新建任务" : item.title}</span>
                      {isRunning(item) ? (
                        <span class="task-spinner" role="status" aria-label={zh ? "正在运行" : "Running"}>
                          <LoaderCircle aria-hidden="true" />
                        </span>
                      ) : (
                        <small>{relative(item.updatedAt, uiLanguage)}</small>
                      )}
                    </button>
                    <button
                      class="item-menu-trigger task-actions-trigger"
                      aria-label="Task actions"
                      disabled={isRunning(item)}
                      onClick={(e) => {
                        e.stopPropagation();
                        const trigger = e.currentTarget.getBoundingClientRect(),
                          list = e.currentTarget.closest(".tasks")?.getBoundingClientRect(),
                          spaceAbove = list ? trigger.top - list.top : trigger.top,
                          spaceBelow = list ? list.bottom - trigger.bottom : innerHeight - trigger.bottom;
                        setTaskMenuDirection(
                          spaceBelow >= 92 || spaceBelow >= spaceAbove ? "down" : "up",
                        );
                        setItemMenu(
                          itemMenu === `task:${item.id}`
                            ? ""
                            : `task:${item.id}`,
                        );
                      }}
                    >
                      <MoreHorizontal />
                    </button>
                    {itemMenu === `task:${item.id}` && (
                      <div class={`item-menu task-actions menu-${taskMenuDirection}`}>
                        <button onClick={() => beginRename(item)}>
                          <FilePenLine />
                          Rename task
                        </button>
                        {item.archivedAt ? (
                          <button onClick={() => archiveTask(item.id, false)}>
                            <ArchiveRestore />
                            Restore task
                          </button>
                        ) : (
                          <button onClick={() => archiveTask(item.id, true)}>
                            <Archive />
                            Archive task
                          </button>
                        )}
                        <button
                          class="danger"
                          onClick={() => deleteTask(item.id)}
                        >
                          <Trash2 />
                          Delete task
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
          {!visible.length && (
            <div class="no-results">
              {showArchived
                ? (zh ? "没有归档任务" : "No archived tasks")
                : (zh ? "还没有任务" : "No tasks yet")}
            </div>
          )}
        </div>
        <footer class="sidebar-footer">
          <button
            class="sidebar-settings"
            aria-label="Settings"
            onClick={() => setShowSettings(true)}
          >
            <SettingsIcon />
            <span>{zh ? "设置" : "Settings"}</span>
          </button>
        </footer>
      </aside>
      {searching && (
        <div
          class="task-search-overlay"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              setSearching(false);
              setQuery("");
            }
          }}
        >
          <section
            class="task-search-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={zh ? "搜索任务" : "Search tasks"}
          >
            <div class="task-search-input">
              <Search />
              <input
                ref={searchInput}
                autoFocus
                value={query}
                placeholder={zh ? "搜索任务" : "Search tasks"}
                onInput={(event) => {
                  setQuery(event.currentTarget.value);
                  setSearchIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setSearchIndex((value) =>
                      Math.min(Math.max(0, searchMatches.length - 1), value + 1),
                    );
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setSearchIndex((value) => Math.max(0, value - 1));
                  } else if (event.key === "Enter" && searchMatches[searchIndex]) {
                    event.preventDefault();
                    selectTask(searchMatches[searchIndex]);
                    setQuery("");
                  }
                }}
              />
              <kbd>ESC</kbd>
            </div>
            <div class="task-search-results">
              <small>{zh ? "任务" : "Tasks"}</small>
              {searchMatches.map((item, index) => (
                <button
                  key={item.id}
                  class={index === searchIndex ? "active" : ""}
                  onPointerMove={() => setSearchIndex(index)}
                  onClick={() => {
                    selectTask(item);
                    setQuery("");
                  }}
                >
                  <MessageCircle />
                  <span>{zh && item.title === "New task" ? "新建任务" : item.title}</span>
                  <em>{item.workspace.split("/").pop() || (zh ? "无项目" : "Standalone")}</em>
                  {item.archivedAt && <Archive />}
                </button>
              ))}
              {!searchMatches.length && (
                <p>{zh ? "没有匹配任务" : "No matching tasks"}</p>
              )}
            </div>
          </section>
        </div>
      )}
      <section class="stage">
          <>
            <header>
              {!sidebarOpen && (
                <button
                  class="sidebar-reveal"
                  aria-label="Show sidebar"
                  title="Show sidebar"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setSidebarOpen(true);
                  }}
                  onClick={() => setSidebarOpen(true)}
                >
                  <PanelLeftOpen />
                </button>
              )}
              {!!turns.length && (
                <div class="task-heading" title={task?.title || (zh ? "新建任务" : "New task")}>
                <strong>{zh && task?.title === "New task" ? "新建任务" : task?.title || (zh ? "新建任务" : "New task")}</strong>
                {task && (
                  <button
                    class="item-menu-trigger header-task-actions"
                    aria-label={zh ? "任务操作" : "Task actions"}
                    aria-expanded={itemMenu === `header:${task.id}`}
                    disabled={isRunning(task)}
                    onClick={() => setItemMenu(itemMenu === `header:${task.id}` ? "" : `header:${task.id}`)}
                  >
                    <MoreHorizontal />
                  </button>
                )}
                {task && itemMenu === `header:${task.id}` && (
                  <div class="item-menu header-task-menu">
                    <button onClick={() => beginRename(task)}>
                      <FilePenLine />
                      Rename task
                    </button>
                    {task.archivedAt ? (
                      <button onClick={() => archiveTask(task.id, false)}>
                        <ArchiveRestore />
                        Restore task
                      </button>
                    ) : (
                      <button onClick={() => archiveTask(task.id, true)}>
                        <Archive />
                        Archive task
                      </button>
                    )}
                    <button class="danger" onClick={() => deleteTask(task.id)}>
                      <Trash2 />
                      Delete task
                    </button>
                  </div>
                )}
                </div>
              )}
              {(!!turns.length || activeBackgroundCount > 0) && (
                <div class="header-actions">
                <button
                  class={`background-trigger ${activeBackgroundCount ? "active" : ""}`}
                  aria-label={zh ? "管理后台程序" : "Manage background processes"}
                  title={zh ? "后台程序" : "Background processes"}
                  aria-expanded={showBackgrounds}
                  onClick={() => setShowBackgrounds((open) => !open)}
                >
                  <SlidersHorizontal />
                  {activeBackgroundCount > 0 && <em>{activeBackgroundCount}</em>}
                </button>
                </div>
              )}
            </header>
            <div
              class={`feed ${running ? "run-active" : ""}`}
              ref={feed}
              onScroll={(e) => {
                const node = e.currentTarget;
                const expected = programmaticScrollTop.current,
                  programmatic = expected !== null && Math.abs(node.scrollTop - expected) < 2,
                  atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
                if (programmatic) programmaticScrollTop.current = null;
                else if (expected !== null) programmaticScrollTop.current = null;
                const nextMode = feedScrollModeAfterScroll(
                  feedScrollMode.current,
                  atBottom,
                  programmatic,
                );
                feedScrollMode.current = nextMode;
                if (nextMode !== 'locked-turn') lockedFeedScrollTop.current = null;
              }}
            >
              {!turns.length && (
                <div class="empty">
                  <BrandMark hero />
                  <h1>
                    {task?.workspace
                      ? (zh ? "我们要构建什么？" : "What are we building?")
                      : (zh ? "我能帮你做什么？" : "How can I help?")}
                  </h1>
                  <div class="hints">
                    {task?.workspace ? (
                      <>
                        <button
                          onClick={() =>
                            setText(
                              "Inspect this codebase and explain its architecture.",
                            )
                          }
                        >
                          {zh ? "检查代码库" : "Inspect the codebase"}
                          <ArrowRight />
                        </button>
                        <button
                          onClick={() =>
                            setText("Find the highest-impact issue and fix it.")
                          }
                        >
                          {zh ? "查找并修复问题" : "Find and fix an issue"}
                          <ArrowRight />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() =>
                            setText(
                              "Help me reason through a technical problem.",
                            )
                          }
                        >
                          {zh ? "分析技术问题" : "Think through a problem"}
                          <ArrowRight />
                        </button>
                        <button
                          onClick={() =>
                            setText("Help me plan a software project.")
                          }
                        >
                          {zh ? "规划软件项目" : "Plan a project"}
                          <ArrowRight />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
              {!!turns.length && (
                <TaskHistory
                  key={currentId}
                  turns={turns}
                  running={running}
                  clock={clock}
                  fork={fork}
                  retry={retry}
                />
              )}
            </div>
            <div class="dock">
              {projectMenu && !turns.length && (
                <div class="project-menu">
                  <div class="project-search">
                    <Search />
                    <input
                      autoFocus
                      value={projectQuery}
                      placeholder="Search projects"
                      onInput={(e) => setProjectQuery(e.currentTarget.value)}
                    />
                  </div>
                  <button
                    class={!task?.workspace ? "active" : ""}
                    onClick={() => setDraftWorkspace("")}
                  >
                    <MessageCircle />
                    <span>Standalone task</span>
                    {!task?.workspace && <Check />}
                  </button>
                  {matchingWorkspaces.map((path) => (
                    <button
                      class={path === task?.workspace ? "active" : ""}
                      title={path}
                      onClick={() => setDraftWorkspace(path)}
                    >
                      <FolderOpen />
                      <span>{path.split("/").pop()}</span>
                      {path === task?.workspace && <Check />}
                    </button>
                  ))}
                  <div class="project-menu-line" />
                  <button onClick={chooseWorkspace}>
                    <Plus />
                    <span>New project</span>
                  </button>
                </div>
              )}
              {(!turns.length || !!task?.workspace || !!activeProgress || !!changeCount) && (
                <div class="context-strip">
                {turns.length ? (task?.workspace ? (
                  <div
                    class="context-workspace"
                    title={task.workspace}
                  >
                    <FolderOpen />
                    <span>{workspace}</span>
                    <button
                      class="detach-project"
                      aria-label={zh ? "移除关联项目" : "Detach project"}
                      title={zh ? "移除关联项目" : "Detach project"}
                      onClick={detachWorkspace}
                    >
                      <X />
                    </button>
                  </div>
                ) : null) : (
                  <div class="draft-project-control">
                    <button
                      class="project-trigger"
                      title={task?.workspace || "Choose project"}
                      onClick={() => setProjectMenu((x) => !x)}
                    >
                      <FolderOpen />
                      <span>{workspace}</span>
                      <ChevronDown />
                    </button>
                    {!!task?.workspace && (
                      <button
                        class="detach-project"
                        aria-label={zh ? "移除关联项目" : "Detach project"}
                        title={zh ? "移除关联项目" : "Detach project"}
                        onClick={detachWorkspace}
                      >
                        <X />
                      </button>
                    )}
                  </div>
                )}
                {activeProgress && (
                  <GoalControl
                    value={activeProgress}
                    now={clock}
                    language={language}
                  />
                )}{" "}
                {!!changeCount && (
                  <button title="Review workspace changes" onClick={review}>
                    <FileDiff />
                    <span>{changeCount} changed</span>
                  </button>
                )}
                </div>
              )}
              {!!queued.filter((x) => x.taskId === currentId).length && (
                <div class="queue">
                  {queued
                    .filter((x) => x.taskId === currentId)
                    .map((x) => (
                      <div>
                  <span>{language === 'zh' ? '已排队' : 'Queued'}</span>
                  <p title={x.text}>{x.text}</p>
                  <button
                    aria-label={
                      language === 'zh'
                        ? '取消这条排队消息'
                        : 'Remove queued message'
                    }
                          onClick={() =>
                            setQueued((q) => q.filter((y) => y.id !== x.id))
                          }
                        >
                          <X />
                        </button>
                      </div>
                    ))}
                </div>
              )}
              {!!matchingCommands.length && (
                <div class="slash-menu">
                  {matchingCommands.map((command) => (
                    <button
                      onClick={() => {
                        setText(`${command.name}${command.args ? " " : ""}`);
                        setTimeout(() => input.current?.focus());
                      }}
                    >
                      <code>{command.name}</code>
                      <span>{command.detail}</span>
                    </button>
                  ))}
                </div>
              )}
              <div class="composer">
                {permissionMenu && (
                  <div class="picker permission-picker">
                    <button
                      class={settings.permission === "ask" ? "active" : ""}
                      onClick={() => {
                        setSettings((x) => ({ ...x, permission: "ask" }));
                        setPermissionMenu(false);
                      }}
                    >
                      <ShieldQuestion />
                      <span>
                        <b>Ask before changes</b>
                        <small>Approve writes and commands</small>
                      </span>
                      <Check />
                    </button>
                    <button
                      class={`full-access-option ${
                        settings.permission === "workspace" ? "active" : ""
                      }`}
                      onClick={() => {
                        setSettings((x) => ({ ...x, permission: "workspace" }));
                        setPermissionMenu(false);
                      }}
                    >
                      <ShieldCheck />
                      <span>
                        <b>Full access</b>
                        <small>Run available tools automatically</small>
                      </span>
                      <Check />
                    </button>
                  </div>
                )}
                {modelMenu && (
                  <div class="picker model-picker">
                    {(models.length ? models : [settings.model]).map(
                      (model) => (
                        <button
                          class={model === settings.model ? "active" : ""}
                          onClick={() => {
                            setSettings((x) => ({ ...x, model }));
                            setModelMenu(false);
                          }}
                        >
                          <Cpu />
                          <span>
                            <b>{model}</b>
                            <small>{provider?.name || "Provider"}</small>
                          </span>
                          <Check />
                        </button>
                      ),
                    )}
                    <button
                      onClick={() => {
                        setModelMenu(false);
                        setShowSettings(true);
                      }}
                    >
                      <SettingsIcon />
                      <span>
                        <b>Model settings</b>
                        <small>Provider and context</small>
                      </span>
                    </button>
                  </div>
                )}
                <textarea
                  ref={input}
                  rows={1}
                  value={text}
                  placeholder={
                    running
                      ? (zh ? "Shun 工作时可继续发送消息…" : "Send a follow-up while Shun works…")
                      : task?.workspace
                        ? (zh ? "让 Shun 构建、检查或修复…" : "Ask Shun to build, inspect, or fix…")
                        : (zh ? "询问 Shun…" : "Ask Shun anything…")
                  }
                  onInput={(e) => setText(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                />
                <div class="bar">
                  <button
                    class={`access ${settings.permission === "workspace" ? "full-access" : ""}`}
                    title="Change tool permissions"
                    onClick={() => {
                      setPermissionMenu(!permissionMenu);
                      setModelMenu(false);
                    }}
                  >
                    {settings.permission === "ask" ? <ShieldQuestion /> : <ShieldCheck />}
                    <span class="access-label">
                      {settings.permission === "ask"
                        ? (zh ? "修改前询问" : "Ask before changes")
                        : (zh ? "完整权限" : "Full access")}
                    </span>
                    <ChevronDown />
                  </button>
                  <ContextMeter
                    value={activeContext}
                    modelWindow={settings.contextWindow}
                    maxOutputTokens={settings.maxTokens}
                  />
                  <button
                    class="model-btn"
                    onClick={() => {
                      setModelMenu(!modelMenu);
                      setPermissionMenu(false);
                    }}
                  >
                    <span class="model-label">{settings.model}</span>
                    <ChevronDown />
                  </button>
                  {running ? (
                    <button
                      class="send stop"
                      aria-label="Stop"
                      onClick={() => window.shun.cancel(running)}
                    >
                      <Square />
                    </button>
                  ) : (
                    <button
                      class="send"
                      aria-label="Send"
                      disabled={!text.trim()}
                      onClick={submit}
                    >
                      <ArrowUp />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </>
      </section>
      {showSettings && (
        <SettingsPage
          value={settings}
          models={models}
          close={() => setShowSettings(false)}
          update={setSettings}
          exportTask={exportTask}
          importTask={importTask}
        />
      )}
      {showBackgrounds && (
        <BackgroundManager
          items={allBackgrounds}
          output={backgroundOutput}
          tasks={tasks}
          now={clock}
          language={uiLanguage}
          close={() => setShowBackgrounds(false)}
          stop={(item) => void window.shun.backgroundStop(item.sessionId, item.id)}
        />
      )}
      {diff !== null && <DiffView text={diff} close={() => setDiff(null)} />}
      {renameTarget && (
        <div
          class="veil rename-veil"
          onPointerDown={(event) => event.target === event.currentTarget && setRenameTarget(null)}
        >
          <form
            class="rename-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-title"
            onPointerDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              commitRename();
            }}
          >
            <h2 id="rename-title">{zh ? "重命名任务" : "Rename task"}</h2>
            <input
              autoFocus
              value={renameTarget.value}
              maxLength={120}
              onInput={(event) => setRenameTarget({ ...renameTarget, value: event.currentTarget.value })}
              onKeyDown={(event) => {
                if (event.key === "Escape") setRenameTarget(null);
              }}
            />
            <div>
              <button type="button" onClick={() => setRenameTarget(null)}>
                {zh ? "取消" : "Cancel"}
              </button>
              <button class="primary" type="submit" disabled={!renameTarget.value.trim()}>
                {zh ? "保存" : "Save"}
              </button>
            </div>
          </form>
        </div>
      )}
      {confirmAction && (
        <div
          class="veil confirm-veil"
          onPointerDown={(e) =>
            e.target === e.currentTarget && setConfirmAction(null)
          }
        >
          <div
            class="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div class="confirm-icon">
              <Trash2 />
            </div>
            <h2 id="confirm-title">{confirmAction.title}</h2>
            <p>{confirmAction.body}</p>
            <div>
              <button onClick={() => setConfirmAction(null)}>Cancel</button>
              <button
                class="danger"
                onClick={() => {
                  const action = confirmAction.action;
                  setConfirmAction(null);
                  action();
                }}
              >
                {confirmAction.label}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function BackgroundManager({
  items,
  output,
  tasks,
  now,
  language,
  close,
  stop,
}: {
  items: BackgroundTask[];
  output: Record<string, BackgroundOutputChunk[]>;
  tasks: Task[];
  now: number;
  language: UiLanguage;
  close: () => void;
  stop: (item: BackgroundTask) => void;
}) {
  const zh = language === 'zh',
    [expandedId, setExpandedId] = useState<string | null>(null),
    activeItems = items.filter((item) => ['starting', 'running', 'stopping'].includes(item.state)),
    activeCount = activeItems.length,
    status: Record<BackgroundTask['state'], string> = zh
      ? { starting: '启动中', running: '运行中', stopping: '停止中', stopped: '已停止', exited: '已退出', failed: '失败' }
      : { starting: 'Starting', running: 'Running', stopping: 'Stopping', stopped: 'Stopped', exited: 'Exited', failed: 'Failed' };
  return (
    <div class="background-popover-layer" onPointerDown={(event) => event.target === event.currentTarget && close()}>
      <section class="background-manager" role="dialog" aria-label={zh ? '后台程序管理' : 'Background process manager'} onPointerDown={(event) => event.stopPropagation()}>
        <header>
          <span><b>{zh ? '环境' : 'Environment'}</b></span>
        </header>
        <div class="background-manager-list">
          <div class="background-section-label"><span>{zh ? '后台程序' : 'Background processes'}</span>{activeCount > 0 && <small>{activeCount}</small>}</div>
          {!activeItems.length && <div class="background-empty"><SquareTerminal /><b>{zh ? '没有后台程序' : 'No background processes'}</b><p>{zh ? 'Shun 启动的服务器、监听器和工作进程会显示在这里。' : 'Servers, watchers, and workers started by Shun will appear here.'}</p></div>}
          {activeItems.map((item) => {
            const active = ['starting', 'running', 'stopping'].includes(item.state),
              seconds = Math.max(0, Math.floor(((item.finishedAt || now) - (item.startedAt || item.createdAt)) / 1000)),
              tail = (output[item.id] || []).slice(-16).map((chunk) => chunk.text).join('').trim(),
              owner = tasks.find((task) => task.id === item.sessionId),
              ownerName = owner?.title || item.workspace.split('/').pop() || item.sessionId,
              expanded = expandedId === item.id;
            return (
              <article class={`background-process state-${item.state}`} key={item.id}>
                <div class="background-process-head">
                  <i />
                  <button class="background-process-summary" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : item.id)}>
                    <span><b>{item.label}</b><small>{ownerName}</small></span>
                    <em>{status[item.state]}</em>
                    {expanded ? <ChevronUp /> : <ChevronDown />}
                  </button>
                </div>
                {expanded && <div class="background-process-detail">
                  <div class="background-process-meta"><time>{seconds}s{item.pid ? ` · PID ${item.pid}` : ''}</time>{active && <button class="background-stop" aria-label={zh ? `停止 ${item.label}` : `Stop ${item.label}`} disabled={item.state === 'stopping'} onClick={() => stop(item)}><Square />{zh ? '停止' : 'Stop'}</button>}</div>
                  <code class="background-command">$ {item.command}</code>
                  {!!item.endpoints.length && <div class="background-endpoints">{item.endpoints.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}</div>}
                  {tail && <pre>{tail}</pre>}
                  {item.error && <p>{item.error}</p>}
                </div>}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function BrandMark({ hero }: { hero?: boolean }) {
  return (
    <span class={hero ? "hero-mark" : "mark"}>
      <img src={logo} alt="" />
    </span>
  );
}
function GoalControl({
  value,
  now,
  language,
}: {
  value: RunProgress;
  now: number;
  language: UiLanguage;
}) {
  void now;
  const zh = language === "zh",
    [open, setOpen] = useState(false),
    root = useRef<HTMLDivElement>(null),
    labels: Record<RunProgress["stage"], string> = zh
      ? {
          research: "来源核验",
          inspection: "定向检查",
          implementation: "实现",
          verification: "验证",
          finalizing: "最终核对",
        }
      : {
          research: "Research",
          inspection: "Inspection",
          implementation: "Implementation",
          verification: "Verification",
          finalizing: "Final check",
        },
    statusLabels = zh
      ? { pending: "待处理", active: "进行中", complete: "已完成" }
      : { pending: "pending", active: "active", complete: "complete" },
    steps = value.steps?.length
      ? value.steps
      : [
          {
            label: value.message,
            status:
              value.state === "complete"
                ? ("complete" as const)
                : ("active" as const),
          },
        ],
    current = steps.find((step) => step.status === "active") || steps.at(-1),
    completed = steps.filter((step) => step.status === "complete").length;
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
        if (!root.current?.contains(event.target as Node)) setOpen(false);
      },
      key = (event: KeyboardEvent) => {
        if (event.key === "Escape") setOpen(false);
      };
    addEventListener("pointerdown", pointer);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("pointerdown", pointer);
      removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div class="goal-control" ref={root}>
      <button
        type="button"
        class={`goal-chip state-${value.state}`}
        aria-label={zh ? "显示任务目标" : "Show task goal"}
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
      >
        <ListChecks />
        <span>
          <b>{labels[value.stage]}</b>
          <small>{current?.label}</small>
        </span>
        <em>
          {completed}/{steps.length}
        </em>
        <ChevronUp />
      </button>
      {open && (
        <section
          class="goal-popover"
          role="dialog"
          aria-label={zh ? "任务目标" : "Task goal"}
        >
          <header>
            <div>
              <b>{zh ? "任务目标" : "Task goal"}</b>
            </div>
          </header>
          <p>{value.message}</p>
          <ol>
            {steps.map((step) => (
              <li class={step.status}>
                <i>{step.status === "complete" ? <Check /> : ""}</i>
                <span>{step.label}</span>
                <em>{statusLabels[step.status]}</em>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
function TaskHistory({
  turns,
  running,
  clock,
  fork,
  retry,
}: {
  turns: Turn[];
  running: string;
  clock: number;
  fork: (id: string) => void;
  retry: (id: string) => void;
}) {
  const language = taskLanguage(turns),
    zh = language === "zh",
    [limit, setLimit] = useState(24),
    visible = turns.slice(-limit),
    hidden = Math.max(0, turns.length - visible.length);
  return (
    <>
      {hidden > 0 && (
        <button class="history-more" onClick={() => setLimit((x) => x + 24)}>
          {zh
            ? `显示之前 ${Math.min(24, hidden)} 条消息`
            : `Show ${Math.min(24, hidden)} earlier messages`}{" "}
          <small>{zh ? `已隐藏 ${hidden} 条` : `${hidden} hidden`}</small>
        </button>
      )}
      {visible.map((turn) => {
        const status = thinkingStatus(turn, running, clock, language),
          runtime =
            turn.role === "assistant" &&
            !turn.error &&
            turn.startedAt &&
            turn.completedAt
              ? formatElapsed(turn.completedAt - turn.startedAt)
              : "";
        return (
          <article
            class={`${turn.role} ${turn.id === running ? "running-turn" : ""}`}
            data-turn-id={turn.id}
            key={turn.id}
          >
            <div class="body">
              <TurnContent turn={turn} running={running} language={language} />
              {status.label && (
                <div class={`thinking ${status.stalled ? "stalled" : ""}`}>
                  <span class="thinking-label text-swipe">
                    <SwipeLayers text={status.label} />
                  </span>
                  <span class="thinking-elapsed">{status.elapsed}</span>
                  {status.quiet && <em>{status.quiet}</em>}
                </div>
              )}
              {runtime && (
                <div class="turn-runtime">
                  {zh ? "耗时" : "Worked for"} {runtime}
                </div>
              )}
              {turn.content && turn.id !== running && (turn.role === "user" || turn.completedAt) && (
                <div class="turn-actions">
                  <button
                    title={zh ? "复制" : "Copy"}
                    onClick={() => navigator.clipboard.writeText(turn.content)}
                  >
                    <Copy />
                    <span>{zh ? "复制" : "Copy"}</span>
                  </button>
                  {turn.role === "assistant" && (
                    <>
                      <button
                        title={zh ? "从这里派生任务" : "Fork task here"}
                        onClick={() => fork(turn.id)}
                      >
                        <GitFork />
                        <span>{zh ? "派生" : "Fork"}</span>
                      </button>
                      {turn.error && (
                        <button onClick={() => retry(turn.id)}>
                          <RotateCcw />
                          {zh ? "重试" : "Retry"}
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </article>
        );
      })}
    </>
  );
}
const fullscreenIcon =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3H3v4M13 3h4v4M17 13v4h-4M7 17H3v-4"/></svg>';
function SwipeLayers({ text }: { text: string }) {
  return (
    <span class="swipe-layers">
      <span class="swipe-base">{text}</span>
      <span class="swipe-glint" aria-hidden="true">
        {text}
      </span>
    </span>
  );
}

function settledToolForDisplay(tool: ToolEvent, live: boolean): ToolEvent {
  return live || (tool.state !== "running" && tool.state !== "waiting")
    ? tool
    : { ...tool, state: "done" };
}

function TurnContent({
  turn,
  running,
  language,
}: {
  turn: Turn;
  running: string;
  language: UiLanguage;
}) {
  const [expanded, setExpanded] = useState(false),
    timeline = turn.timeline || [],
    grouped = groupedTimeline(timeline),
    hidden = expanded ? 0 : Math.max(0, grouped.length - 60),
    entries = hidden ? grouped.slice(hidden) : grouped;
  if (timeline.length)
    return (
      <div class="turn-flow">
        {hidden > 0 && (
          <button class="activity-more" onClick={() => setExpanded(true)}>
            {language === "zh"
              ? `显示之前 ${hidden} 项活动`
              : `Show ${hidden} earlier activity items`}
          </button>
        )}
        {entries.map((entry: any, i) => {
          const hasLaterText = entries
            .slice(i + 1)
            .some((later: any) => later.type === "text" && later.text.trim());
          const activityLive = turn.id === running && !hasLaterText;
          return entry.type === "tool-group" ? (
            <ActionGroup
              key={`${entry.tools[0]?.batchId || entry.tools[0]?.id}-${entry.kind}`}
              runId={turn.id}
              tools={entry.tools}
              kind={entry.kind}
              language={language}
              live={activityLive}
            />
          ) : entry.type === "text" ? (
            <Message
              key={`${hidden + i}-text`}
              text={entry.text}
              streaming={turn.id === running}
            />
          ) : entry.type === "tool" ? (
            <Tool
              key={entry.tool.id}
              runId={turn.id}
              tool={settledToolForDisplay(entry.tool, activityLive)}
            />
          ) : (
            <ContextNotice
              key={`${hidden + i}-context`}
              value={entry.context}
              language={language}
            />
          );
        })}
      </div>
    );
  const tools = turnTools(turn);
  return (
    <>
      {!!tools.length && (
        <ToolGroup
          runId={turn.id}
          tools={tools}
          live={turn.id === running && !turn.content.trim()}
        />
      )}{" "}
      {turn.content && (
        <Message text={turn.content} streaming={turn.id === running} />
      )}
    </>
  );
}

function groupedTimeline(entries: NonNullable<Turn["timeline"]>) {
  const result: any[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.type === "text" && isActionProgress(entry.text)) continue;
    if (entry.type === "tool") {
      const kind = toolGroupKind(entry.tool),
        target = toolTarget(entry.tool);
      const previous = result.at(-1);
      const refreshesFailedEdit =
        entry.tool.name === "read" &&
        entry.tool.state === "done" &&
        previous?.type === "tool-group" &&
        previous.kind === "change" &&
        previous.target === target &&
        previous.tools.some(isRefreshableEditFailure);
      if (refreshesFailedEdit) {
        previous.tools.push(entry.tool);
        previous.recovered = true;
        continue;
      }
      const sameBatch = Boolean(
        entry.tool.batchId && previous?.batchId === entry.tool.batchId,
      );
      const sameLogicalActivity =
        previous?.type === "tool-group" &&
        previous.kind === kind &&
        (kind !== "change" || previous.target === target);
      if (
        previous?.type === "tool-group" &&
        previous.kind === kind &&
        (sameBatch || sameLogicalActivity)
      )
        previous.tools.push(entry.tool);
      else
        result.push({
          type: "tool-group",
          kind,
          target,
          batchId: entry.tool.batchId,
          tools: [entry.tool],
        });
      continue;
    }
    result.push(entry);
  }
  return result;
}

function isActionProgress(text: string) {
  const value = text.trim();
  if (
    /^(?:Running focused verification\.|Inspecting only the source ranges needed for the next change\.|Reading only the files needed for the next change\.|Applying the next coherent change\.|Recording evidence from the selected official sources\.)$/i.test(
      value,
    )
  )
    return true;
  // Tool rows already show these intermediate actions. Keeping the model's
  // slightly reworded narration between every read prevents related reads
  // from collapsing into one useful activity group.
  return (
    value.length < 260 &&
    /^(?:正在(?:读取|检查|定位|运行|执行|重新运行|修复|实施|准备修改)|类型检查已通过)/.test(
      value,
    )
  );
}
function isShellInspection(tool: ToolEvent) {
  if (!isShellTool(tool)) return false;
  return /^(?:sed\s+-n|grep\b|rg\b|cat\b|head\b|tail\b|ls\b|find\b|wc\b)/i.test(shellCommand(tool));
}
function isVerificationRun(tool: ToolEvent) {
  if (!isShellTool(tool)) return false;
  return /(?:^|&&|;)\s*(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|typecheck|build|lint))\b|(?:^|&&|;)\s*(?:npx\s+)?tsc\b|(?:^|&&|;)\s*node\s+--test\b|\b(?:vitest|jest|pytest)\b/i.test(shellCommand(tool));
}
function toolGroupKind(tool: ToolEvent) {
  return tool.name === "web_search" || tool.name === "web_read"
    ? "research"
    : tool.name === "write" || tool.name === "edit" || tool.name === "edit_lines" || tool.name === "replace_all"
      ? "change"
      : isVerificationRun(tool)
        ? "verification"
        : isShellTool(tool) && !isShellInspection(tool)
          ? "command"
        : "inspection";
}
function isRefreshableEditFailure(tool: ToolEvent) {
  return (
    (tool.name === "edit" || tool.name === "edit_lines" || tool.name === "replace_all") &&
    tool.state === "error" &&
    /Expected one exact match, found (?:0|[2-9]\d*)/.test(tool.output || "")
  );
}
function recoveredEditGroup(tools: ToolEvent[]) {
  return (
    tools.some(isRefreshableEditFailure) &&
    tools.some(
      (tool) =>
        tool.name === "read" &&
        tool.state === "done" &&
        tools.some(
          (failed) =>
            isRefreshableEditFailure(failed) &&
            toolTarget(failed) === toolTarget(tool),
        ),
    )
  );
}
function toolTarget(tool: ToolEvent) {
  try {
    const input = JSON.parse(tool.input || "{}");
    return String(
      tool.name === "web_search" || tool.name === "search"
        ? input.query
        : tool.name === "web_read"
          ? input.url
          : tool.name === "mcp_list"
            ? input.server || "configured MCP servers"
            : tool.name === "mcp_call"
              ? `${input.server || "MCP"}/${input.name || "tool"}`
          : isShellTool(tool)
            ? shellCommand(tool)
            : input.path || ".",
    ).trim();
  } catch {
    return tool.name;
  }
}
function shortTarget(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {}
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 64 ? `${compact.slice(0, 61)}…` : compact;
}
function actionGroupCopy(
  tools: ToolEvent[],
  kind: "research" | "inspection" | "command" | "change" | "verification",
  language: UiLanguage,
) {
  const zh = language === "zh",
    running = tools.some(
      (tool) => tool.state === "running" || tool.state === "waiting",
    ),
    recovered = recoveredEditGroup(tools),
    failures = tools.filter(
      (tool) =>
        tool.state === "error" &&
        !(recovered && isRefreshableEditFailure(tool)),
    ).length,
    allFailed = summarizedFailureCount(failures, tools.length) > 0;
  const targets = [
    ...new Set(
      tools.map((tool) => shortTarget(toolTarget(tool))).filter(Boolean),
    ),
  ];
  const targetList = targets.slice(0, 3).join("、"),
    extra =
      targets.length > 3
        ? zh
          ? ` 等 ${targets.length} 个`
          : ` +${targets.length - 3} more`
        : "";
  const visibleFailures = summarizedFailureCount(failures, tools.length),
    failureText = visibleFailures
    ? zh
      ? `${visibleFailures} 次失败`
      : `${visibleFailures} failed`
    : "";
  const detail = [
    targetList ? `${targetList}${extra}` : "",
    failureText,
  ]
    .filter(Boolean)
    .join(" · ");
  if (kind === "change")
    return {
      title: zh
        ? running
          ? "正在修改"
          : recovered
            ? `已刷新 ${targets[0] || "修改原文"}`
            : allFailed
              ? "修改未成功"
              : targets.length === 1
                ? `已修改 ${targets[0]}`
                : `已修改 ${targets.length} 个文件`
        : running
          ? "Applying changes"
          : recovered
            ? `Refreshed ${targets[0] || "edit source"}`
            : allFailed
              ? "Changes failed"
              : targets.length === 1
                ? `Changed ${targets[0]}`
                : `Changed ${targets.length} files`,
      detail: recovered
        ? zh
          ? "原文已变化 · 已读取当前内容"
          : "Source changed · current content loaded"
        : failureText,
    };
  if (kind === "research")
    {
      const opened = new Set(tools.filter((tool) => tool.name === "web_read" && tool.state === "done").map(toolTarget));
      const searches = new Set(tools.filter((tool) => tool.name === "web_search" && tool.state === "done").map(toolTarget));
      return {
        title: zh
          ? running
            ? "正在获取来源证据"
            : allFailed
              ? "获取来源未成功"
            : opened.size
              ? `已打开 ${opened.size} 个来源`
              : `已完成 ${searches.size} 次网页搜索`
          : running
            ? "Retrieving source evidence"
            : allFailed
              ? "Source retrieval failed"
            : opened.size
              ? `Opened ${opened.size} sources`
              : `Completed ${searches.size} web searches`,
        detail: [opened.size && searches.size ? (zh ? `${searches.size} 次搜索` : `${searches.size} searches`) : "", failureText].filter(Boolean).join(" · "),
      };
    }
  if (kind === "command")
    return {
      title: zh
        ? running
          ? "正在运行命令"
          : allFailed
            ? "命令未成功"
            : "命令已完成"
        : running
          ? "Running command"
          : allFailed
            ? "Command failed"
            : "Command completed",
      detail,
    };
  if (kind === "inspection")
    {
      const reads = tools.filter((tool) => tool.name === "read").length,
        searches = tools.length - reads;
      return {
        title: zh
          ? running
            ? "正在读取或搜索代码"
            : allFailed
              ? "读取或搜索未成功"
            : reads && !searches
              ? reads === 1 && targets[0]
                ? `已读取 ${targets[0]}`
                : `已读取 ${reads} 个文件`
              : `已完成 ${tools.length} 项读取/搜索`
          : running
            ? "Reading or searching code"
            : allFailed
              ? "Read or search failed"
            : reads && !searches
              ? reads === 1 && targets[0]
                ? `Read ${targets[0]}`
                : `Read ${reads} files`
              : `Completed ${tools.length} read/search actions`,
        detail: [targetList ? `${targetList}${extra}` : "", failureText].filter(Boolean).join(" · "),
      };
    }
  return {
    title: zh
      ? running
        ? "正在验证"
        : allFailed
          ? "验证未通过"
          : "验证已完成"
      : running
        ? "Verifying"
        : allFailed
          ? "Verification failed"
          : "Verification completed",
    detail,
  };
}

function ActionGroup({
  tools: sourceTools,
  runId,
  language,
  kind,
  live,
}: {
  tools: ToolEvent[];
  runId: string;
  language: UiLanguage;
  kind: "research" | "inspection" | "command" | "change" | "verification";
  live: boolean;
}) {
  const tools = sourceTools.map((tool) => settledToolForDisplay(tool, live));
  const [open, setOpen] = useState(false),
    running = tools.some(
      (tool) => tool.state === "running" || tool.state === "waiting",
    ),
    executing = tools.some((tool) => tool.state === "running"),
    recovered = recoveredEditGroup(tools),
    failures = tools.filter(
      (tool) =>
        tool.state === "error" &&
        !(recovered && isRefreshableEditFailure(tool)),
    ).length,
    allFailed = failures > 0 && failures === tools.length,
    copy = actionGroupCopy(tools, kind, language),
    Icon =
      kind === "research" || kind === "inspection"
        ? Search
        : kind === "change"
          ? FilePenLine
          : SquareTerminal;
  return (
    <section
      class={`activity action-summary kind-${kind} ${running ? "active" : ""} ${executing ? "executing" : ""} ${allFailed ? "has-error" : ""}`}
    >
      <button class="activity-head" onClick={() => setOpen((value) => !value)}>
        <Icon />
        <span>
          <b class={executing ? "text-swipe" : ""}>
            {executing ? <SwipeLayers text={copy.title} /> : copy.title}
          </b>
          {copy.detail && <small>{copy.detail}</small>}
        </span>
        {open ? <ChevronUp /> : <ChevronDown />}
      </button>
      {open && (
        <div class="activity-list">
          {tools.map((tool) => (
            <Tool
              key={tool.id}
              runId={runId}
              tool={tool}
              recovered={recovered && isRefreshableEditFailure(tool)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
function Message({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const node = useRef<HTMLDivElement>(null);
  const mermaidUi = useRef(
    new Map<number, { visual: boolean; scrollTop: number; scrollLeft: number }>(),
  );
  useLayoutEffect(() => {
    let live = true;
    const cleanups: (() => void)[] = [];
    const completedMermaidBlocks = completedMermaidBlockCount(text);
    let mermaidBlockIndex = 0;
    node.current?.querySelectorAll("pre").forEach((pre, index) => {
      if (pre.parentElement?.classList.contains("code-shell")) return;
      const code = pre.querySelector("code"),
        source = code?.textContent || "",
        lang =
          [...(code?.classList || [])]
            .find((x) => x.startsWith("language-"))
            ?.slice(9) || "text",
        shell = document.createElement("div"),
        head = document.createElement("div"),
        label = document.createElement("span"),
        copy = document.createElement("button");
      shell.className = `code-shell${lang === "mermaid" ? " mermaid-shell" : ""}`;
      head.className = "code-head";
      label.textContent = lang;
      copy.textContent = "Copy";
      copy.onclick = async () => {
        await navigator.clipboard.writeText(source);
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1200);
      };
      head.append(label);
      pre.before(shell);
      if (lang !== "mermaid") {
        head.append(copy);
        shell.append(head, pre);
        return;
      }
      const blockIndex = mermaidBlockIndex;
      const blockComplete = blockIndex < completedMermaidBlocks;
      mermaidBlockIndex += 1;
      const diagram = document.createElement("div"),
        stage = document.createElement("div"),
        diagramButton = document.createElement("button"),
        codeButton = document.createElement("button"),
        expandButton = document.createElement("button");
      diagram.className = "mermaid-view";
      stage.className = "mermaid-stage";
      diagramButton.textContent = "Diagram";
      codeButton.textContent = "Code";
      const ui = mermaidUi.current.get(blockIndex) || {
        visual: true,
        scrollTop: 0,
        scrollLeft: 0,
      };
      const show = (visual: boolean) => {
        ui.visual = visual;
        mermaidUi.current.set(blockIndex, ui);
        shell.classList.toggle("show-code", !visual);
        diagramButton.classList.toggle("active", visual);
        codeButton.classList.toggle("active", !visual);
      };
      let rendered = "",
        modal: HTMLDivElement | null = null,
        previousFocus: HTMLElement | null = null;
      const closeModal = () => {
        if (!modal) return;
        modal.remove();
        modal = null;
        if (!document.querySelector(".diagram-modal"))
          document.body.classList.remove("diagram-open");
        previousFocus?.focus({ preventScroll: true });
        previousFocus = null;
      };
      const openModal = () => {
        closeModal();
        previousFocus = document.activeElement as HTMLElement;
        const overlay = document.createElement("div"),
          dialog = document.createElement("div"),
          modalHead = document.createElement("div"),
          title = document.createElement("strong"),
          actions = document.createElement("div"),
          visualButton = document.createElement("button"),
          sourceButton = document.createElement("button"),
          modalCopy = document.createElement("button"),
          zoomControls = document.createElement("div"),
          zoomOut = document.createElement("button"),
          zoomReset = document.createElement("button"),
          zoomIn = document.createElement("button"),
          close = document.createElement("button"),
          canvas = document.createElement("div"),
          modalStage = document.createElement("div"),
          sourceView = document.createElement("pre"),
          sourceCode = document.createElement("code");
        modal = overlay;
        overlay.className = "diagram-modal";
        dialog.className = "diagram-dialog";
        dialog.role = "dialog";
        dialog.ariaModal = "true";
        dialog.ariaLabel = "Diagram viewer";
        modalHead.className = "diagram-modal-head";
        actions.className = "diagram-modal-actions";
        canvas.className = "diagram-modal-canvas";
        modalStage.className = "diagram-modal-stage";
        sourceView.className = "diagram-modal-code";
        zoomControls.className = "diagram-zoom-controls";
        title.textContent = "Diagram";
        visualButton.textContent = "Diagram";
        sourceButton.textContent = "Code";
        modalCopy.textContent = "Copy";
        zoomOut.textContent = "−";
        zoomOut.ariaLabel = "Zoom out";
        zoomIn.textContent = "+";
        zoomIn.ariaLabel = "Zoom in";
        zoomReset.textContent = "Fit";
        zoomReset.ariaLabel = "Fit diagram to view";
        close.className = "diagram-modal-close";
        close.innerHTML =
          '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 4 12 12M16 4 4 16"/></svg>';
        close.ariaLabel = "Close diagram";
        sourceCode.textContent = source;
        sourceView.append(sourceCode);
        modalStage.innerHTML =
          rendered || '<span class="mermaid-pending">Drawing diagram…</span>';
        const display = (visual: boolean) => {
          overlay.classList.toggle("show-code", !visual);
          visualButton.classList.toggle("active", visual);
          sourceButton.classList.toggle("active", !visual);
        };
        let zoom = 1;
        const diagramSvg = () => modalStage.querySelector<SVGSVGElement>("svg");
        const svgSize = () => {
          const svg = diagramSvg();
          if (!svg) return null;
          const viewBox = svg.viewBox.baseVal;
          const width = viewBox.width || Number(svg.getAttribute("width")) || 1;
          const height = viewBox.height || Number(svg.getAttribute("height")) || 1;
          return { svg, width, height };
        };
        const updateZoomControls = () => {
          zoomReset.textContent = `${Math.round(zoom * 100)}%`;
          zoomOut.disabled = zoom <= 0.2;
          zoomIn.disabled = zoom >= 3;
        };
        const center = () =>
          requestAnimationFrame(() => {
            canvas.scrollLeft = Math.max(
              0,
              (canvas.scrollWidth - canvas.clientWidth) / 2,
            );
            canvas.scrollTop = Math.max(
              0,
              (canvas.scrollHeight - canvas.clientHeight) / 2,
            );
          });
        const setZoom = (next: number, recenter = false) => {
          const size = svgSize();
          if (!size) return;
          const oldWidth = Math.max(canvas.scrollWidth, 1);
          const oldHeight = Math.max(canvas.scrollHeight, 1);
          const centerX = (canvas.scrollLeft + canvas.clientWidth / 2) / oldWidth;
          const centerY = (canvas.scrollTop + canvas.clientHeight / 2) / oldHeight;
          zoom = Math.max(0.2, Math.min(3, next));
          size.svg.style.width = `${size.width * zoom}px`;
          size.svg.style.height = `${size.height * zoom}px`;
          updateZoomControls();
          if (recenter) {
            center();
            return;
          }
          requestAnimationFrame(() => {
            canvas.scrollLeft = Math.max(0, centerX * canvas.scrollWidth - canvas.clientWidth / 2);
            canvas.scrollTop = Math.max(0, centerY * canvas.scrollHeight - canvas.clientHeight / 2);
          });
        };
        const fit = () => requestAnimationFrame(() => {
          const size = svgSize();
          if (!size) return;
          const availableWidth = Math.max(1, canvas.clientWidth - 80);
          const availableHeight = Math.max(1, canvas.clientHeight - 80);
          setZoom(Math.min(1, availableWidth / size.width, availableHeight / size.height), true);
        });
        let startX = 0,
          startY = 0,
          scrollX = 0,
          scrollY = 0;
        canvas.onpointerdown = (event) => {
          if (event.button) return;
          startX = event.clientX;
          startY = event.clientY;
          scrollX = canvas.scrollLeft;
          scrollY = canvas.scrollTop;
          canvas.classList.add("dragging");
          canvas.setPointerCapture(event.pointerId);
        };
        canvas.onpointermove = (event) => {
          if (!canvas.classList.contains("dragging")) return;
          canvas.scrollLeft = scrollX - event.clientX + startX;
          canvas.scrollTop = scrollY - event.clientY + startY;
        };
        canvas.onpointerup = canvas.onpointercancel = (event) => {
          canvas.classList.remove("dragging");
          if (canvas.hasPointerCapture(event.pointerId))
            canvas.releasePointerCapture(event.pointerId);
        };
        canvas.onwheel = (event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          setZoom(zoom * (event.deltaY > 0 ? 0.9 : 1.1));
        };
        visualButton.onclick = () => {
          display(true);
          fit();
        };
        sourceButton.onclick = () => display(false);
        modalCopy.onclick = copy.onclick;
        zoomOut.onclick = () => setZoom(zoom / 1.2);
        zoomIn.onclick = () => setZoom(zoom * 1.2);
        zoomReset.onclick = fit;
        close.onclick = closeModal;
        overlay.onclick = (event) => {
          if (event.target === overlay) closeModal();
        };
        zoomControls.append(zoomOut, zoomReset, zoomIn);
        actions.append(zoomControls, visualButton, sourceButton, modalCopy, close);
        modalHead.append(title, actions);
        canvas.append(modalStage);
        dialog.append(modalHead, canvas, sourceView);
        overlay.append(dialog);
        document.body.append(overlay);
        document.body.classList.add("diagram-open");
        const currentTheme =
          document.documentElement.dataset.theme === "light" ? "light" : "dark";
        const currentAccent =
          (document.documentElement.dataset.accent || "blue") as Settings["accent"];
        syncMermaidTheme(currentTheme, currentAccent);
        display(true);
        fit();
        close.focus({ preventScroll: true });
      };
      const escape = (event: KeyboardEvent) => {
        if (event.key === "Escape" && modal) closeModal();
      };
      addEventListener("keydown", escape);
      cleanups.push(() => {
        removeEventListener("keydown", escape);
        closeModal();
      });
      diagramButton.onclick = () => show(true);
      codeButton.onclick = () => show(false);
      expandButton.className = "diagram-expand";
      expandButton.innerHTML = fullscreenIcon;
      expandButton.ariaLabel = "Open diagram in a large view";
      expandButton.title = "Open diagram";
      expandButton.onclick = openModal;
      head.append(diagramButton, codeButton, copy);
      diagram.append(stage, expandButton);
      shell.append(head, diagram, pre);
      show(ui.visual);
      pre.scrollTop = ui.scrollTop;
      pre.scrollLeft = ui.scrollLeft;
      const rememberCodeScroll = () => {
        ui.scrollTop = pre.scrollTop;
        ui.scrollLeft = pre.scrollLeft;
        mermaidUi.current.set(blockIndex, ui);
      };
      pre.addEventListener("scroll", rememberCodeScroll, { passive: true });
      cleanups.push(() => pre.removeEventListener("scroll", rememberCodeScroll));
      if (streaming && !blockComplete) {
        stage.innerHTML =
          '<span class="mermaid-pending">Drawing diagram…</span>';
        return;
      }
      const insertDiagram = (svg: string) => {
        rendered = svg;
        stage.innerHTML = rendered;
        const modalStage = modal?.querySelector(".diagram-modal-stage");
        if (modalStage) modalStage.innerHTML = rendered;
        const currentTheme =
          document.documentElement.dataset.theme === "light" ? "light" : "dark";
        const currentAccent =
          (document.documentElement.dataset.accent || "blue") as Settings["accent"];
        syncMermaidTheme(currentTheme, currentAccent);
      };
      const cached = cachedMermaidRender(source);
      if (cached.svg) insertDiagram(cached.svg);
      else {
        stage.innerHTML =
          '<span class="mermaid-pending">Drawing diagram…</span>';
      }
      cached.promise
        .then((svg) => {
          if (!live) return;
          insertDiagram(svg);
        })
        .catch(() => {
          if (!live) return;
          show(false);
          stage.innerHTML =
            '<span class="mermaid-error">Unable to draw this diagram</span>';
        });
    });
    return () => {
      live = false;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [text, streaming]);
  return (
    <div
      ref={node}
      class="copy"
      dangerouslySetInnerHTML={{
        __html: DOMPurify.sanitize(
          markdown.parse(normalizeMarkdown(text), {
            breaks: true,
            async: false,
          }) as string,
        ),
      }}
    />
  );
}

async function renderMermaid(source: string) {
  const light = document.documentElement.dataset.theme === "light",
    accent = document.documentElement.dataset.accent === "violet"
      ? "#8b6ee8"
      : document.documentElement.dataset.accent === "orange"
        ? "#d87943"
        : "#5277d9";
  const normalized = normalizeMermaid(source);
  const palette = {
    bg: light ? "#ffffff" : "#101113",
    fg: light ? "#1e1e1e" : "#e9ecef",
    line: light ? "#1e1e1e" : "#e9ecef",
    accent,
    muted: light ? "#868e96" : "#9aa0aa",
    surface: "transparent",
    border: light ? "#bbbbbb" : "#7a7a7a",
  };
  const { renderExcalidrawFlow } = await (excalidrawMermaidClient ||=
    import("./mermaid/excalidraw-flow"));
  const excalidraw = await renderExcalidrawFlow(normalized, palette);
  if (excalidraw) return excalidraw;
  const { default: render } = await (mermaidClient ||=
    import("./mermaid/svg.js"));
  return render(normalized, palette);
}
function normalizeMermaid(source: string) {
  return source.replace(/^\s*(?:style|classDef)\s+.+$/gim, "").trim();
}
const bareUrlCjkBoundary =
  /(https?:\/\/[^\s<>"'`、，。；：！？（）【】《》「」『』〈〉]+)(?=[、，。；：！？（）【】《》「」『』〈〉])/g;

function separateBareUrlBoundaries(line: string) {
  // Marked otherwise consumes CJK punctuation and the following URL as one
  // autolink. The zero-width HTML boundary gives it an explicit URL endpoint
  // without adding visible spacing before the punctuation.
  return line
    .split(/(`+[^`]*`+)/g)
    .map((part, index) =>
      index % 2 ? part : part.replace(bareUrlCjkBoundary, "$1<wbr>"),
    )
    .join("");
}

function normalizeMarkdown(text: string) {
  let fenced = false;
  const normalized = text
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return line;
      }
      return fenced ? line : separateBareUrlBoundaries(line);
    })
    .join("\n");
  return fenced ? `${normalized}\n\`\`\`` : normalized;
}
function ToolGroup({ tools: sourceTools, runId, live }: { tools: ToolEvent[]; runId: string; live: boolean }) {
  const tools = sourceTools.map((tool) => settledToolForDisplay(tool, live));
  const active = tools.some(
      (x) => x.state === "running" || x.state === "waiting",
    ),
    executing = tools.some((x) => x.state === "running"),
    kinds = [
      ...new Set(
        tools.map((x) =>
          isShellTool(x)
            ? "ran commands"
            : x.name === "web_search"
              ? "searched web"
            : x.name === "web_read"
                ? "read web"
                : x.name === "mcp_list" || x.name === "mcp_call"
                  ? "used MCP"
                : x.name === "read" || x.name === "list" || x.name === "search"
                  ? "read files"
                  : "edited files",
        ),
      ),
    ],
    [open, setOpen] = useState(active);
  useEffect(() => setOpen(active), [active]);
  return (
    <section class={`activity ${active ? "active" : ""} ${executing ? "executing" : ""}`}>
      <button class="activity-head" onClick={() => setOpen(!open)}>
        <FilePenLine />
        <span>
          <b class={executing ? "text-swipe" : ""}>
            {executing ? <SwipeLayers text="Working" /> : sentence(kinds.join(", "))}
          </b>
        </span>
        {open ? <ChevronUp /> : <ChevronDown />}
      </button>
      {open && (
        <div class="activity-list">
          {tools.map((tool) => (
            <Tool key={tool.id} runId={runId} tool={tool} />
          ))}
        </div>
      )}
    </section>
  );
}
function Tool({
  tool,
  runId,
  recovered = false,
}: {
  tool: ToolEvent;
  runId: string;
  recovered?: boolean;
}) {
  const [open, setOpen] = useState(tool.state === "waiting"),
    rawDetail = toolDetail(tool),
    detail = recovered
      ? { title: "Source changed", detail: rawDetail.detail }
      : rawDetail,
    change = toolDiff(tool),
    Icon =
      isShellTool(tool)
        ? SquareTerminal
        : tool.name === "web_search"
          ? Search
          : tool.name === "mcp_list" || tool.name === "mcp_call"
            ? Cable
          : tool.name === "write" || tool.name === "edit" || tool.name === "edit_lines" || tool.name === "replace_all"
            ? FilePenLine
            : Files;
  useEffect(() => {
    if (tool.state === "waiting") setOpen(true);
  }, [tool.state]);
  return (
    <div class={`tool-row ${recovered ? "state-done" : `state-${tool.state}`}`}>
      <button class="tool-row-head" onClick={() => setOpen(!open)}>
        <Icon />
        <span>
          <b class={tool.state === "running" ? "text-swipe" : ""}>
            {tool.state === "running" ? <SwipeLayers text={detail.title} /> : detail.title}
          </b>
          <small>{detail.detail}</small>
        </span>
        <em>
          {recovered
            ? "Refreshed"
            : tool.state === "waiting"
              ? "Review"
              : tool.state === "running"
                ? "Running"
                : tool.state === "error"
                  ? "Failed"
                  : ""}
        </em>
        {open ? <ChevronUp /> : <ChevronDown />}
      </button>
      {open && (
        <div class="tool-row-body">
          <div class="tool-kind">
            {change ? "Changes" : isShellTool(tool) ? "Shell" : "Output"}
          </div>
          {change ? (
            <InlineDiff text={change} />
          ) : (
            <pre>
              {isShellTool(tool)
                ? `$ ${detail.detail}${tool.output ? `\n\n${tool.output}` : ""}`
                : tool.output ||
                  (tool.state === "waiting" ? tool.input : "No output")}
            </pre>
          )}
          <div
            class={`tool-result ${recovered ? "state-done" : `state-${tool.state}`}`}
          >
            {recovered
              ? "✓ Current source loaded"
              : tool.state === "error"
                ? "Failed"
                : tool.state === "running"
                  ? "Running"
                  : tool.state === "waiting"
                    ? "Approval needed"
                    : "✓ Success"}
          </div>
          {tool.state === "waiting" && (
            <div class="approve">
              <button
                onClick={() => window.shun.approve(runId, tool.id, false)}
              >
                <X />
                Deny
              </button>
              <button
                class="allow"
                onClick={() => window.shun.approve(runId, tool.id, true)}
              >
                <Check />
                Allow once
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
function InlineDiff({ text }: { text: string }) {
  return (
    <div class="inline-diff">
      {text.split("\n").map((line, i) => {
        const meta =
            line.startsWith("diff ") ||
            line.startsWith("index ") ||
            line.startsWith("---") ||
            line.startsWith("+++") ||
            line.startsWith("==="),
          kind = meta
            ? "meta"
            : line.startsWith("@@")
              ? "hunk"
              : line.startsWith("+")
                ? "add"
                : line.startsWith("-")
                  ? "del"
                  : "context";
        return (
          <div key={i} class={kind}>
            <span>{meta || line.startsWith("@@") ? " " : line[0] || " "}</span>
            <code>{meta || line.startsWith("@@") ? line : line.slice(1)}</code>
          </div>
        );
      })}
    </div>
  );
}
function toolDiff(tool: ToolEvent) {
  if (tool.diff) return tool.diff;
  if (tool.name !== "edit" || tool.state === "error") return "";
  try {
    const input = JSON.parse(tool.input),
      old = typeof input.old === "string" ? input.old : "",
      next = typeof input.next === "string" ? input.next : "";
    if (!old || old === next) return "";
    return `@@ proposed change @@\n-${old.replace(/\n/g, "\n-")}\n+${next.replace(/\n/g, "\n+")}`;
  } catch {
    return "";
  }
}
function toolDetail(tool: ToolEvent) {
  let input: any = {};
  try {
    input = JSON.parse(tool.input);
  } catch {}
  const value = String(
    tool.name === "search" || tool.name === "web_search"
      ? input.query
      : tool.name === "web_read"
        ? input.url
        : tool.name === "mcp_list"
          ? input.server || "configured MCP servers"
          : tool.name === "mcp_call"
            ? `${input.server || "MCP"}/${input.name || "tool"}`
        : isShellTool(tool)
          ? shellCommand(tool)
          : input.path || ".",
  );
  return tool.name === "write"
    ? {
        title:
          tool.state === "error"
            ? "Write failed"
            : tool.state === "waiting"
              ? "Write proposed"
              : "Wrote",
        detail: value,
      }
    : tool.name === "edit" || tool.name === "edit_lines" || tool.name === "replace_all"
      ? {
          title:
            tool.state === "error"
              ? "Edit failed"
              : tool.state === "waiting"
                ? "Edit proposed"
                : "Edited",
          detail: value,
        }
      : tool.name === "read"
        ? { title: "Read", detail: value }
        : tool.name === "search"
          ? { title: "Searched", detail: value }
          : tool.name === "web_search"
            ? { title: "Searched web", detail: value }
            : tool.name === "web_read"
              ? { title: "Read web", detail: value }
              : tool.name === "mcp_list"
                ? { title: "Discovered MCP", detail: value }
                : tool.name === "mcp_call"
                  ? { title: tool.state === "error" ? "MCP call failed" : tool.state === "waiting" ? "MCP call proposed" : "Called MCP", detail: value }
              : tool.name === "list"
                ? { title: "Listed", detail: value }
                : isShellTool(tool)
                  ? { title: "Ran", detail: value }
                  : { title: sentence(tool.name), detail: value };
}
function LegacySettingsPage({
  value,
  models,
  update,
  close,
  exportTask,
  importTask,
}: {
  value: Settings;
  models: string[];
  update: (fn: (x: Settings) => Settings) => void;
  close: () => void;
  exportTask: () => void;
  importTask: () => void;
}) {
  const [tab, setTab] = useState<"providers" | "model" | "agent">("providers"),
    active =
      value.providers.find((x) => x.id === value.providerId) ||
      value.providers[0],
    field = (key: keyof Settings, next: any) =>
      update((x) => ({ ...x, [key]: next })),
    select = (provider: Provider) =>
      update((x) => ({
        ...x,
        providerId: provider.id,
        endpoint: provider.endpoint,
        apiKey: provider.apiKey,
        contextWindow: provider.contextWindow,
      })),
    edit = (
      key: "name" | "endpoint" | "apiKey" | "contextWindow",
      next: string | number,
    ) =>
      update((x) => ({
        ...x,
        ...(key === "name" ? {} : { [key]: next }),
        providers: x.providers.map((p) =>
          p.id === active.id ? { ...p, [key]: next } : p,
        ),
      })),
    add = () => {
      const provider: Provider = {
        id: uid(),
        name: "New provider",
        kind: "custom",
        endpoint: "http://127.0.0.1:8000/v1",
        apiKey: "",
        contextWindow: 32768,
      };
      update((x) => ({
        ...x,
        providers: [...x.providers, provider],
        providerId: provider.id,
        endpoint: provider.endpoint,
        apiKey: "",
        contextWindow: provider.contextWindow,
      }));
    },
    remove = () =>
      update((x) => {
        const providers = x.providers.filter((p) => p.id !== active.id),
          provider = providers[0];
        return {
          ...x,
          providers,
          providerId: provider.id,
          endpoint: provider.endpoint,
          apiKey: provider.apiKey,
          contextWindow: provider.contextWindow,
        };
      });
  return (
    <div class="settings-page">
      <header class="settings-title">
        <button class="back" onClick={close}>
          <ArrowLeft />
        </button>
        <div>
          <h1>Settings</h1>
          <p>Configure providers, models, and the agent runtime.</p>
        </div>
      </header>
      <div class="settings-layout">
        <nav>
          <button
            class={tab === "providers" ? "active" : ""}
            onClick={() => setTab("providers")}
          >
            <Server />
            Providers
          </button>
          <button
            class={tab === "model" ? "active" : ""}
            onClick={() => setTab("model")}
          >
            <Cpu />
            Model & context
          </button>
          <button
            class={tab === "agent" ? "active" : ""}
            onClick={() => setTab("agent")}
          >
            <SlidersHorizontal />
            Agent
          </button>
        </nav>
        <div class="settings-content">
          {tab === "providers" && (
            <section>
              <div class="section-head">
                <div>
                  <h2>Providers</h2>
                  <p>Any OpenAI-compatible local or remote endpoint.</p>
                </div>
                <button class="add-provider" onClick={add}>
                  <Plus />
                  Add provider
                </button>
              </div>
              <div class="provider-layout">
                <div class="provider-list">
                  {value.providers.map((provider) => (
                    <button
                      class={provider.id === active.id ? "active" : ""}
                      onClick={() => select(provider)}
                    >
                      <span class={`provider-icon ${provider.kind}`}>
                        <Server />
                      </span>
                      <span>
                        <b>{provider.name}</b>
                        <small>{provider.kind}</small>
                      </span>
                      {provider.id === active.id && <Check />}
                    </button>
                  ))}
                </div>
                <div class="provider-editor">
                  <div class="connection">
                    <i class={models.length ? "online" : ""} />
                    <b>
                      {models.length
                        ? `Connected · ${models.length} models`
                        : "Not connected"}
                    </b>
                    {value.providers.length > 1 && (
                      <button
                        class="remove-provider"
                        title="Remove provider"
                        onClick={remove}
                      >
                        <Trash2 />
                      </button>
                    )}
                  </div>
                  <label>
                    Name
                    <input
                      value={active.name}
                      onInput={(e) => edit("name", e.currentTarget.value)}
                    />
                  </label>
                  <label>
                    Base URL
                    <input
                      value={active.endpoint}
                      onInput={(e) => edit("endpoint", e.currentTarget.value)}
                    />
                  </label>
                  <label>
                    API key <span>optional</span>
                    <div class="key-input">
                      <KeyRound />
                      <input
                        type="password"
                        value={active.apiKey}
                        placeholder="Not required for most local servers"
                        onInput={(e) => edit("apiKey", e.currentTarget.value)}
                      />
                    </div>
                  </label>
                  <label>
                    Context window
                    <input
                      type="number"
                      min="4096"
                      step="4096"
                      value={active.contextWindow}
                      onInput={(e) =>
                        edit(
                          "contextWindow",
                          Math.max(4096, +e.currentTarget.value),
                        )
                      }
                    />
                    <small>
                      Use the limit configured by this provider/model
                      deployment.
                    </small>
                  </label>
                  <p class="help">
                    Shun calls <code>/models</code> and{" "}
                    <code>/chat/completions</code> on this base URL.
                  </p>
                </div>
              </div>
            </section>
          )}
          {tab === "model" && (
            <section>
              <div class="section-head">
                <div>
                  <h2>Model & context</h2>
                  <p>Defaults tuned for capable local models.</p>
                </div>
              </div>
              <div class="form-grid">
                <label class="wide">
                  Model
                  <input
                    list="model-list"
                    value={value.model}
                    onInput={(e) => field("model", e.currentTarget.value)}
                  />
                  <datalist id="model-list">
                    {models.map((x) => (
                      <option value={x} />
                    ))}
                  </datalist>
                  <small>
                    {models.length
                      ? "Select a detected model or type an exact model id."
                      : "Start the provider to discover models."}
                  </small>
                </label>
                <label>
                  Temperature
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step=".1"
                    value={value.temperature}
                    onInput={(e) =>
                      field("temperature", +e.currentTarget.value)
                    }
                  />
                </label>
                <label>
                  Max output tokens
                  <input
                    type="number"
                    min="512"
                    step="512"
                    value={value.maxTokens}
                    onInput={(e) => field("maxTokens", +e.currentTarget.value)}
                  />
                </label>
                <label class="toggle-row">
                  <span>
                    <b>Automatic compaction</b>
                    <small>
                      Summarize older turns and tool results before context
                      overflow.
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    checked={value.autoCompact}
                    onChange={(e) =>
                      field("autoCompact", e.currentTarget.checked)
                    }
                  />
                </label>
              </div>
              <div class="context-note">
                <Server />
                <div>
                  <b>{active.contextWindow.toLocaleString()} token context</b>
                  <p>
                    Configured with the active provider. Change it in Providers
                    when the deployment limit changes.
                  </p>
                </div>
              </div>
            </section>
          )}
          {tab === "agent" && (
            <section>
              <div class="section-head">
                <div>
                  <h2>Agent runtime</h2>
                  <p>Control tool execution and task permissions.</p>
                </div>
              </div>
              <div class="choice">
                <button
                  class={value.permission === "ask" ? "active" : ""}
                  onClick={() => field("permission", "ask")}
                >
                  <ShieldQuestion />
                  <span>
                    <b>Ask before changes</b>
                    <small>
                      Approve writes, edits, and commands individually.
                    </small>
                  </span>
                </button>
                <button
                  class={`full-access-option ${
                    value.permission === "workspace" ? "active" : ""
                  }`}
                  onClick={() => field("permission", "workspace")}
                >
                  <ShieldCheck />
                  <span>
                    <b>Workspace access</b>
                    <small>
                      Run tools automatically inside the selected folder.
                    </small>
                  </span>
                </button>
              </div>
              <div class="context-note">
                <i class="runtime-dot" />
                <div>
                  <b>No task wall-clock limit</b>
                  <p>
                    Shun can keep working while the project advances. Individual
                    provider calls use an adaptive watchdog so one stalled
                    response cannot hang the task indefinitely.
                  </p>
                </div>
              </div>
              <div class="context-note">
                <FolderOpen />
                <div>
                  <b>Project instructions</b>
                  <p>
                    Shun automatically loads AGENTS.md, CLAUDE.md, and
                    .shun/SYSTEM.md from the workspace root.
                  </p>
                </div>
              </div>
              <div class="session-actions">
                <div>
                  <b>Task portability</b>
                  <p>
                    Move a complete task, including messages and tool history.
                  </p>
                </div>
                <button onClick={importTask}>
                  <Upload />
                  Import
                </button>
                <button onClick={exportTask}>
                  <Download />
                  Export current
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
function SettingsPage({
  value,
  models,
  update,
  close,
  exportTask,
  importTask,
}: {
  value: Settings;
  models: string[];
  update: (fn: (x: Settings) => Settings) => void;
  close: () => void;
  exportTask: () => void;
  importTask: () => void;
}) {
  const [tab, setTab] = useState<"providers" | "mcp" | "model" | "appearance" | "agent">("providers"),
    active = value.providers.find((item) => item.id === value.providerId) || value.providers[0],
    activeModels = normalizeProviderModels(active, value.contextWindow),
    zh = resolveUiLanguage(value.language) === "zh",
    t = (en: string, cn: string) => zh ? cn : en,
    field = (key: keyof Settings, next: any) => update((current) => ({ ...current, [key]: next }));

  const selectProvider = (provider: Provider) => {
    const list = normalizeProviderModels(provider, provider.contextWindow),
      model = list.find((item) => item.id === value.model) || list[0];
    update((current) => ({
      ...current,
      providerId: provider.id,
      endpoint: provider.endpoint,
      apiKey: provider.apiKey,
      model: model?.id || current.model,
      contextWindow: model?.contextWindow || provider.contextWindow,
      maxTokens: model?.maxOutputTokens || current.maxTokens,
    }));
  };
  const editProvider = (key: "name" | "endpoint" | "apiKey", next: string) =>
    update((current) => ({
      ...current,
      ...(key === "name" ? {} : { [key]: next }),
      providers: current.providers.map((provider) => provider.id === active.id ? { ...provider, [key]: next } : provider),
    }));
  const addProvider = () => {
    const provider: Provider = {
      id: uid(), name: t("New provider", "新 Provider"), kind: "custom",
      endpoint: "http://127.0.0.1:8000/v1", apiKey: "", contextWindow: 32768,
      models: [{ id: "model-id", contextWindow: 32768, maxOutputTokens: 8192 }],
    };
    update((current) => ({ ...current, providers: [...current.providers, provider], providerId: provider.id, endpoint: provider.endpoint, apiKey: "", model: "model-id", contextWindow: 32768, maxTokens: 8192 }));
  };
  const removeProvider = () => update((current) => {
    const nextProviders = current.providers.filter((provider) => provider.id !== active.id),
      provider = nextProviders[0],
      model = normalizeProviderModels(provider, provider.contextWindow)[0];
    return { ...current, providers: nextProviders, providerId: provider.id, endpoint: provider.endpoint, apiKey: provider.apiKey, model: model?.id || current.model, contextWindow: model?.contextWindow || provider.contextWindow, maxTokens: model?.maxOutputTokens || current.maxTokens };
  });
  const editModel = (id: string, key: keyof ProviderModel, next: string | number) => update((current) => {
    let selectedId = current.model;
    const nextProviders = current.providers.map((provider) => {
      if (provider.id !== active.id) return provider;
      const list = normalizeProviderModels(provider, current.contextWindow).map((model) => {
        if (model.id !== id) return model;
        if (key === "id" && current.model === id) selectedId = String(next);
        return { ...model, [key]: next };
      });
      return { ...provider, models: list };
    }),
      selected = normalizeProviderModels(nextProviders.find((provider) => provider.id === active.id)!, current.contextWindow).find((model) => model.id === selectedId);
    return { ...current, providers: nextProviders, model: selectedId, contextWindow: selected?.contextWindow || current.contextWindow, maxTokens: selected?.maxOutputTokens || current.maxTokens };
  });
  const chooseModel = (id: string) => {
    const model = activeModels.find((item) => item.id === id);
    if (model) update((current) => ({ ...current, model: id, contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens }));
  };
  const addModel = () => update((current) => {
    const list = normalizeProviderModels(active, current.contextWindow),
      model = { id: `model-${list.length + 1}`, contextWindow: active.contextWindow || current.contextWindow, maxOutputTokens: current.maxTokens || 8192 };
    return { ...current, model: model.id, contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens, providers: current.providers.map((provider) => provider.id === active.id ? { ...provider, models: [...list, model] } : provider) };
  });
  const removeModel = (id: string) => update((current) => {
    const list = normalizeProviderModels(active, current.contextWindow).filter((model) => model.id !== id),
      selected = current.model === id ? list[0] : list.find((model) => model.id === current.model);
    return { ...current, model: selected?.id || current.model, contextWindow: selected?.contextWindow || current.contextWindow, maxTokens: selected?.maxOutputTokens || current.maxTokens, providers: current.providers.map((provider) => provider.id === active.id ? { ...provider, models: list } : provider) };
  });
  const addMcpServer = () => update((current) => ({
    ...current,
    mcpServers: [...(current.mcpServers || []), { id: `mcp-${(current.mcpServers || []).length + 1}`, name: t("Local MCP", "本地 MCP"), url: "http://127.0.0.1:3000/mcp", enabled: true }],
  }));
  const editMcpServer = (id: string, key: keyof McpServer, next: string | boolean) => update((current) => ({
    ...current,
    mcpServers: (current.mcpServers || []).map((server) => server.id === id ? { ...server, [key]: next } : server),
  }));
  const removeMcpServer = (id: string) => update((current) => ({
    ...current,
    mcpServers: (current.mcpServers || []).filter((server) => server.id !== id),
  }));

  return (
    <div class="veil settings-modal-veil" onPointerDown={(event) => event.target === event.currentTarget && close()}>
      <section class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onPointerDown={(event) => event.stopPropagation()}>
        <header class="settings-title">
          <div><h1 id="settings-title">{t("Settings", "设置")}</h1><p>{t("Providers, models, runtime, and appearance.", "管理 Provider、模型、运行参数与外观。")}</p></div>
          <button class="icon settings-close" aria-label={t("Close settings", "关闭设置")} onClick={close}><X /></button>
        </header>
        <div class="settings-layout">
          <nav>
            <button type="button" class={tab === "providers" ? "active" : ""} onPointerDown={() => setTab("providers")} onClick={() => setTab("providers")}><Server />{t("Providers", "Provider")}</button>
            <button type="button" class={tab === "mcp" ? "active" : ""} onPointerDown={() => setTab("mcp")} onClick={() => setTab("mcp")}><Cable />MCP</button>
            <button type="button" class={tab === "model" ? "active" : ""} onPointerDown={() => setTab("model")} onClick={() => setTab("model")}><Cpu />{t("Model & context", "模型与上下文")}</button>
            <button type="button" class={tab === "appearance" ? "active" : ""} onPointerDown={() => setTab("appearance")} onClick={() => setTab("appearance")}><Palette />{t("Appearance", "外观")}</button>
            <button type="button" class={tab === "agent" ? "active" : ""} onPointerDown={() => setTab("agent")} onClick={() => setTab("agent")}><SlidersHorizontal />Agent</button>
          </nav>
          <div class="settings-content">
            {tab === "providers" && <section>
              <div class="section-head"><div><h2>{t("Providers", "Provider")}</h2><p>{t("Connection details and the models exposed by each endpoint.", "连接信息，以及每个端点暴露的模型。")}</p></div><button class="add-provider" onClick={addProvider}><Plus />{t("Add provider", "添加 Provider")}</button></div>
              <div class="provider-layout">
                <div class="provider-list">{value.providers.map((provider) => <button class={provider.id === active.id ? "active" : ""} onClick={() => selectProvider(provider)}><span class={`provider-icon ${provider.kind}`}><Server /></span><span><b>{provider.name}</b><small>{normalizeProviderModels(provider, provider.contextWindow).length} {t("models", "个模型")}</small></span>{provider.id === active.id && <Check />}</button>)}</div>
                <div class="provider-editor">
                  <div class="connection"><i class={models.length ? "online" : ""} /><b>{models.length ? t(`Connected · ${models.length} models`, `已连接 · ${models.length} 个模型`) : t("Not connected", "未连接")}</b>{value.providers.length > 1 && <button class="remove-provider" title={t("Remove provider", "移除 Provider")} onClick={removeProvider}><Trash2 /></button>}</div>
                  <div class="provider-fields">
                    <label>{t("Name", "名称")}<input value={active.name} onInput={(event) => editProvider("name", event.currentTarget.value)} /></label>
                    <label>Base URL<input value={active.endpoint} onInput={(event) => editProvider("endpoint", event.currentTarget.value)} /></label>
                    <label class="wide">API key <span>{t("optional", "可选")}</span><div class="key-input"><KeyRound /><input type="password" value={active.apiKey} placeholder={t("Not required for most local servers", "多数本地服务不需要")} onInput={(event) => editProvider("apiKey", event.currentTarget.value)} /></div></label>
                  </div>
                  <p class="help">{t("Shun calls", "Shun 会调用")} <code>/models</code> {t("and", "和")} <code>/chat/completions</code>。</p>
                  <div class="provider-models-head"><span><b>{t("Models", "模型")}</b><small>{t("Context and output limits belong to each model deployment.", "上下文与输出上限属于具体模型部署。")}</small></span><button class="add-provider" onClick={addModel}><Plus />{t("Add model", "添加模型")}</button></div>
                  <div class="provider-models">{activeModels.map((model) => <div class={`provider-model-row ${model.id === value.model ? "active" : ""}`}>
                    <button class="model-select" title={t("Use this model", "使用此模型")} onClick={() => chooseModel(model.id)}><Check /></button>
                    <label>{t("Model ID", "模型 ID")}<input value={model.id} onInput={(event) => editModel(model.id, "id", event.currentTarget.value)} /></label>
                    <label>{t("Context", "上下文")}<input type="number" min="4096" step="4096" value={model.contextWindow} onInput={(event) => editModel(model.id, "contextWindow", Math.max(4096, +event.currentTarget.value))} /></label>
                    <label>{t("Max output", "最大输出")}<input type="number" min="512" step="512" value={model.maxOutputTokens} onInput={(event) => editModel(model.id, "maxOutputTokens", Math.max(512, +event.currentTarget.value))} /></label>
                    <button class="remove-model" aria-label={t("Remove model", "移除模型")} disabled={activeModels.length < 2} onClick={() => removeModel(model.id)}><Trash2 /></button>
                  </div>)}</div>
                </div>
              </div>
            </section>}
            {tab === "mcp" && <section>
              <div class="section-head"><div><h2>MCP</h2><p>{t("Configured Streamable HTTP servers exposed to the agent through a strict allowlist.", "通过严格白名单向 Agent 开放已配置的 Streamable HTTP server。")}</p></div><button class="add-provider" onClick={addMcpServer}><Plus />{t("Add server", "添加 server")}</button></div>
              <div class="mcp-settings-list">{(value.mcpServers || []).map((server) => <div class="mcp-server-row">
                <label class="mcp-enabled"><input type="checkbox" checked={server.enabled !== false} onChange={(event) => editMcpServer(server.id, "enabled", event.currentTarget.checked)} /><span>{t("Enabled", "启用")}</span></label>
                <label>{t("ID", "ID")}<input value={server.id} onInput={(event) => editMcpServer(server.id, "id", event.currentTarget.value)} /></label>
                <label>{t("Name", "名称")}<input value={server.name} onInput={(event) => editMcpServer(server.id, "name", event.currentTarget.value)} /></label>
                <label class="mcp-url">URL<input value={server.url} placeholder="http://127.0.0.1:3000/mcp" onInput={(event) => editMcpServer(server.id, "url", event.currentTarget.value)} /></label>
                <button class="remove-model" aria-label={t("Remove MCP server", "移除 MCP server")} onClick={() => removeMcpServer(server.id)}><Trash2 /></button>
              </div>)}</div>
              {!(value.mcpServers || []).length && <div class="mcp-empty"><Cable /><b>{t("No MCP servers configured", "尚未配置 MCP server")}</b><p>{t("Add a trusted local or HTTPS Streamable HTTP endpoint. The model never receives permission to choose arbitrary URLs.", "添加可信的本地或 HTTPS Streamable HTTP 端点；模型无权自行选择任意 URL。")}</p></div>}
            </section>}
            {tab === "model" && <section>
              <div class="section-head"><div><h2>{t("Model & context", "模型与上下文")}</h2><p>{t("Choose a deployment and tune request-time behavior.", "选择当前部署，并调整请求时运行参数。")}</p></div></div>
              <div class="form-grid">
                <label>Provider<select value={active.id} onChange={(event) => selectProvider(value.providers.find((item) => item.id === event.currentTarget.value)!)}>{value.providers.map((provider) => <option value={provider.id}>{provider.name}</option>)}</select></label>
                <label>{t("Model", "模型")}<select value={value.model} onChange={(event) => chooseModel(event.currentTarget.value)}>{activeModels.map((model) => <option value={model.id}>{model.name || model.id}</option>)}</select></label>
                <label>Temperature<input type="number" min="0" max="2" step=".1" value={value.temperature} onInput={(event) => field("temperature", +event.currentTarget.value)} /></label>
                <label>{t("Max output tokens", "最大输出 token")}<input type="number" min="512" step="512" value={value.maxTokens} onInput={(event) => editModel(value.model, "maxOutputTokens", Math.max(512, +event.currentTarget.value))} /></label>
                <label class="toggle-row"><span><b>{t("Automatic compaction", "自动压缩上下文")}</b><small>{t("Summarize older turns before context overflow.", "在上下文溢出前压缩较早对话。")}</small></span><input type="checkbox" checked={value.autoCompact} onChange={(event) => field("autoCompact", event.currentTarget.checked)} /></label>
              </div>
              <div class="context-note"><Server /><div><b>{value.contextWindow.toLocaleString()} token context</b><p>{t("This limit comes from the selected model deployment. Edit it under Providers.", "该上限来自当前模型部署，可在 Provider 中修改。")}</p></div></div>
            </section>}
            {tab === "appearance" && <section>
              <div class="section-head"><div><h2>{t("Appearance", "外观")}</h2><p>{t("Language, interface theme, and one shared accent color.", "语言、界面主题与统一强调色。")}</p></div></div>
              <div class="appearance-group"><div class="appearance-label"><Languages /><span><b>{t("Language", "语言")}</b><small>{t("Task output still follows the user.", "任务输出仍跟随用户语言。")}</small></span></div><div class="segmented three">{(["system", "en", "zh-CN"] as const).map((item) => <button class={value.language === item ? "active" : ""} onClick={() => field("language", item)}>{item === "system" ? t("System", "跟随系统") : item === "en" ? "English" : "简体中文"}</button>)}</div></div>
              <div class="appearance-group"><div class="appearance-label"><Palette /><span><b>{t("Theme", "主题")}</b><small>{t("Mermaid diagrams switch with the interface.", "Mermaid 图表会随界面切换。")}</small></span></div><div class="segmented three">{(["system", "dark", "light"] as const).map((item) => <button class={value.theme === item ? "active" : ""} onClick={() => field("theme", item)}>{item === "system" ? t("System", "跟随系统") : item === "dark" ? t("Dark", "深色") : t("Light", "浅色")}</button>)}</div></div>
              <div class="appearance-group"><div class="appearance-label"><span class={`accent-preview ${value.accent || "blue"}`} /><span><b>{t("Accent", "强调色")}</b><small>{t("Shared by selection, progress, context, and diagrams.", "统一用于选中、进度、上下文与图表。")}</small></span></div><div class="accent-options">{(["blue", "violet", "orange"] as const).map((item) => <button class={`${item} ${value.accent === item ? "active" : ""}`} aria-label={item} onClick={() => field("accent", item)}><i /></button>)}</div></div>
            </section>}
            {tab === "agent" && <section>
              <div class="section-head"><div><h2>{t("Agent runtime", "Agent 运行设置")}</h2><p>{t("Tool execution and task permissions.", "工具执行与任务权限。")}</p></div></div>
              <div class="choice"><button class={value.permission === "ask" ? "active" : ""} onClick={() => field("permission", "ask")}><ShieldQuestion /><span><b>{t("Ask before changes", "修改前询问")}</b><small>{t("Approve writes, edits, and commands.", "逐项批准写入、编辑与命令。")}</small></span></button><button class={`full-access-option ${value.permission === "workspace" ? "active" : ""}`} onClick={() => field("permission", "workspace")}><ShieldCheck /><span><b>{t("Full access", "完整权限")}</b><small>{t("Run the tools available to this task automatically.", "自动运行当前任务可用的工具。")}</small></span></button></div>
              <div class="session-actions"><div><b>{t("Task portability", "任务导入导出")}</b><p>{t("Move a complete task with messages and tool history.", "迁移包含消息与工具历史的完整任务。")}</p></div><button onClick={importTask}><Upload />{t("Import", "导入")}</button><button onClick={exportTask}><Download />{t("Export current", "导出当前任务")}</button></div>
            </section>}
          </div>
        </div>
      </section>
    </div>
  );
}

function DiffView({ text, close }: { text: string; close: () => void }) {
  const files = useMemo(() => splitDiff(text), [text]),
    [selected, setSelected] = useState(0),
    file = files[Math.min(selected, files.length - 1)];
  return (
    <div
      class="veil"
      onPointerDown={(e) => e.target === e.currentTarget && close()}
    >
      <div class="diff-view" onPointerDown={(e) => e.stopPropagation()}>
        <div class="diff-title">
          <span>
            <h2>Workspace changes</h2>
            <small>
              {files.length} {files.length === 1 ? "file" : "files"}
            </small>
          </span>
          <button type="button" class="icon" onClick={close}>
            <X />
          </button>
        </div>
        <div class="diff-layout">
          <nav class="diff-files">
            {files.map((item, i) => (
              <button
                key={`${item.path}-${i}`}
                type="button"
                class={i === selected ? "active" : ""}
                aria-pressed={i === selected}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setSelected(i);
                }}
                onClick={() => setSelected(i)}
                title={item.path}
              >
                <FilePenLine />
                <span>
                  <b>{item.path.split("/").pop()}</b>
                  <small>{item.path}</small>
                </span>
                <em>
                  <i>+{item.additions}</i>
                  <del>−{item.deletions}</del>
                </em>
              </button>
            ))}
          </nav>
          <section class="diff-file">
            <header>
              <FilePenLine />
              <span>
                <b>{file?.path || "Changes"}</b>
                <small>
                  {file?.additions || 0} additions · {file?.deletions || 0}{" "}
                  deletions
                </small>
              </span>
            </header>
            <div class="workspace-diff">
              <InlineDiff text={file?.text ?? ""} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
function relative(time: number, language: UiLanguage = "en") {
  const seconds = Math.max(0, (Date.now() - time) / 1000);
  return seconds < 60
    ? language === "zh" ? "现在" : "Now"
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h`
        : `${Math.floor(seconds / 86400)}d`;
}
function taskGroups(tasks: Task[]) {
  const groups = new Map<string, Task[]>();
  for (const task of tasks)
    groups.set(task.workspace, [...(groups.get(task.workspace) || []), task]);
  const ranked = [...groups]
      .filter(([workspace]) => workspace)
      .sort(
        (a, b) =>
          Math.max(...b[1].map((x) => x.updatedAt)) -
          Math.max(...a[1].map((x) => x.updatedAt)),
      )
      .map(([workspace, tasks]) => ({ workspace, tasks })),
    loose = groups.get("");
  return loose ? [...ranked, { workspace: "", tasks: loose }] : ranked;
}
function turnTools(turn: Turn) {
  return turn.tools?.length
    ? turn.tools
    : (turn.timeline || []).flatMap((entry) =>
        entry.type === "tool" ? [entry.tool] : [],
      );
}
function stateForStorage(
  settings: Settings,
  tasks: Task[],
  currentId: string,
): SavedState {
  const persistedTasks = keepCurrentDraft(tasks, currentId, hasTaskMessages)
    .map((task) => ({
      ...task,
      turns: task.turns.map((turn) =>
        turn.timeline?.some((entry) => entry.type === "tool")
          ? { ...turn, tools: undefined }
          : turn,
      ),
    }));
  return {
    settings,
    currentId: persistedTasks.some((task) => task.id === currentId)
      ? currentId
      : persistedTasks[0]?.id || "",
    tasks: persistedTasks,
  };
}
function changedFiles(turns: Turn[]) {
  const files = new Set<string>();
  for (const turn of turns)
    for (const tool of turnTools(turn))
      if (tool.state === "done" && ["write", "edit"].includes(tool.name))
        try {
          const path = JSON.parse(tool.input).path;
          if (path) files.add(path);
        } catch {}
  return [...files];
}
function changedDiffs(turns: Turn[]) {
  return turns.flatMap((turn) =>
    turnTools(turn)
      .filter(
        (tool) =>
          tool.state === "done" &&
          ["write", "edit"].includes(tool.name) &&
          tool.diff,
      )
      .map((tool) => tool.diff!),
  );
}
function webHistory(turns: Turn[]) {
  const discovered = new Set<string>(),
    opened = new Set<string>(),
    sources = new Map<string, NonNullable<ToolEvent["source"]>>();
  for (const turn of turns)
    for (const tool of turnTools(turn))
      if (tool.state === "done") {
        const input = parseJson(tool.input),
          output = parseJson(tool.output);
        if (tool.name === "web_search")
          for (const result of output.results || [])
            if (result.url) discovered.add(String(result.url));
        if (tool.name === "web_read" && (tool.source || (output.ok === true && String(output.content || "").trim()))) {
          const source = tool.source || {
            requestedUrl: String(input.url || ""),
            finalUrl: String(output.final_url || input.url || ""),
            title: String(output.title || output.final_url || input.url || ""),
            contentType: String(output.content_type || ""),
            fetchMethod: String(output.fetch_method || ""),
            ...(Number(output.pages) ? { pages: Number(output.pages) } : {}),
          };
          if (isSoftNotFoundSource(source)) continue;
          if (source.finalUrl) sources.set(source.finalUrl, source);
          for (const url of [source.requestedUrl, source.finalUrl])
            if (url) discovered.add(String(url));
          // Redirect aliases are discovery paths to one parsed document, not
          // separate opened sources. Persist only the canonical final receipt.
          if (source.finalUrl) opened.add(String(source.finalUrl));
        }
      }
  return { discoveredUrls: [...discovered], openedUrls: [...opened], sources: [...sources.values()] };
}
function resumeHistory(
  turns: Turn[],
): NonNullable<import("../../shared").AgentRequest["resume"]> {
  const progress = [...turns].reverse().find((turn) => turn.progress)?.progress;
  const stage =
    progress?.stage === "implementation" || progress?.stage === "verification"
      ? progress.stage
      : "inspection";
  const changedFiles = new Set<string>(),
    scratchArtifacts = new Set<string>(),
    inspected = new Map<
      string,
      { path: string; output: string; offset: number; limit: number }
    >(),
    recentToolResults = new Map<
      string,
      { name: string; input: string; output: string; state: "done" | "error" }
    >();
  for (const turn of turns)
    for (const tool of turnTools(turn))
      if (tool.state === "done" || tool.state === "error") {
        const input = parseJson(tool.input),
          path = String(input.path || "");
        if (
          tool.state === "done" &&
          path &&
          (tool.name === "write" || tool.name === "edit" || tool.name === "edit_lines" || tool.name === "replace_all")
        ) {
          if (
            tool.name === "write" &&
            isAgentScratchPath(path) &&
            /@@ -0,0 \+\d+/.test(tool.diff || "")
          )
            scratchArtifacts.add(path);
          else changedFiles.add(path);
          for (const [key, item] of inspected)
            if (item.path === path) inspected.delete(key);
        }
        if (
          tool.state === "done" &&
          path &&
          tool.name === "read" &&
          tool.output
        ) {
          const offset = Math.max(1, Math.floor(Number(input.offset) || 1)),
            limit = Math.min(
              Math.max(1, Math.floor(Number(input.limit) || 300)),
              800,
            ),
            key = `${path}\0${offset}\0${limit}`;
          // Successful reads survive retry. A later write/edit to the same path
          // invalidates them above, so unchanged ranges can be reused safely.
          inspected.delete(key);
          const output = tool.output
            .replace(/^(?:Cached inspection \(unchanged\):\s*)+/i, "")
            .replace(
              /\nUse a different line range only if a specific omitted detail is required\.\s*$/i,
              "",
            );
          const firstLine = Number(output.match(/^(\d+):/m)?.[1] || offset);
          // Ignore legacy cache entries whose displayed line numbers contradict
          // their requested range. Earlier builds could attach a whole-file cache
          // to an arbitrary offset; carrying it forward hides the required source.
          if (offset > 1 && firstLine < offset) continue;
          inspected.set(key, {
            path,
            offset,
            limit,
            output: output.slice(0, 20_000),
          });
        }
        if (tool.output && (tool.state === "error" || isShellTool(tool))) {
          const key = `${tool.name}\0${tool.input}`,
            existing = recentToolResults.get(key);
          if (
            tool.state === "error" &&
            existing?.state === "done" &&
            /already succeeded|blocked exact retry/i.test(tool.output)
          )
            continue;
          recentToolResults.delete(key);
          recentToolResults.set(key, {
            name: tool.name,
            input: tool.input,
            output: compactResumeToolOutput(tool.output),
            state: tool.state,
          });
        }
      }
  const providerFailure = latestProviderFailure(turns);
  if (providerFailure)
    recentToolResults.set("provider\0latest", {
      name: "provider",
      input: "{}",
      output: providerFailure.slice(-1_500),
      state: "error",
    });
  const snapshots = [...inspected.values()],
    prioritized = snapshots.filter((item) => changedFiles.has(item.path)),
    recent = [...snapshots]
      .reverse()
      .filter((item) => !changedFiles.has(item.path));
  return {
    stage,
    changedFiles: [...changedFiles],
    scratchArtifacts: [...scratchArtifacts],
    inspected: [...prioritized, ...recent].slice(0, 12),
    recentToolResults: [...recentToolResults.values()].slice(-48),
  };
}
function isAgentScratchPath(path: string) {
  return /(?:^|\/)(?:\.claude\/scratchpad|\.codex(?:\/|$)|\.shun\/scratch)(?:\/|$)/i.test(
    path.replace(/\\/g, "/"),
  );
}
function parseJson(value?: string) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}
function isDiffProtocol(line: string) {
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("Index: ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("@@") ||
    /^(?:new|deleted) file mode /.test(line) ||
    /^(?:old|new) mode /.test(line) ||
    /^(?:similarity|dissimilarity) index /.test(line) ||
    /^(?:rename|copy) (?:from|to) /.test(line) ||
    /^Binary files .+ differ$/.test(line) ||
    /^={8,}\s*$/.test(line)
  );
}
function splitDiff(text: string) {
  const chunks: string[][] = [];
  let lines: string[] = [],
    hasNew = false;
  for (const line of text.split("\n")) {
    const boundary =
      line.startsWith("diff --git ") ||
      line.startsWith("Index: ") ||
      (line.startsWith("--- ") && hasNew);
    if (boundary && lines.length) {
      chunks.push(lines);
      lines = [];
      hasNew = false;
    }
    lines.push(line);
    if (line.startsWith("+++ ")) hasNew = true;
  }
  if (lines.length) chunks.push(lines);
  return chunks
    .filter((lines) =>
      lines.some((line) => line.startsWith("+") || line.startsWith("-")),
    )
    .map((lines, i) => {
      let path = "";
      for (const line of lines) {
        if (line.startsWith("Index: ")) path = line.slice(7).trim();
        else if (line.startsWith("diff --git "))
          path = line.match(/ b\/(.+)$/)?.[1] || path;
        else if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null"))
          path = line.slice(4).trim().split(/\s/)[0].replace(/^b\//, "");
        else if (
          line.startsWith("--- ") &&
          !line.startsWith("--- /dev/null") &&
          !path
        )
          path = line.slice(4).trim().split(/\s/)[0].replace(/^a\//, "");
      }
      const additions = lines.filter(
          (line) => line.startsWith("+") && !line.startsWith("+++"),
        ).length,
        deletions = lines.filter(
          (line) => line.startsWith("-") && !line.startsWith("---"),
        ).length,
        display = lines.filter((line) => !isDiffProtocol(line));
      while (display[0] === "") display.shift();
      while (display.at(-1) === "") display.pop();
      return {
        path: path || `Change ${i + 1}`,
        additions,
        deletions,
        text: display.join("\n"),
      };
    });
}
function applyPending(tasks: Task[], pending: Map<string, string>) {
  if (!pending.size) return tasks;
  return tasks.map((task) => {
    let changed = false;
    const turns = task.turns.map((turn) => {
      const text = pending.get(turn.id);
      if (!text) return turn;
      changed = true;
      return applyEvent(turn, { id: turn.id, type: "delta", text });
    });
    return changed ? { ...task, turns, updatedAt: Date.now() } : task;
  });
}
function applyEvent(turn: Turn, event: AgentEvent): Turn {
  const now = Date.now();
  if (event.type === "delta") {
    const text = event.text || "";
    return {
      ...turn,
      content: turn.content + text,
      timeline: appendText(turn.timeline, text),
      lastActivityAt: now,
    };
  }
  if (event.type === "phase")
    return { ...turn, phase: event.text || "Thinking", lastActivityAt: now };
  if (event.type === "progress" && event.progress)
    return {
      ...turn,
      progress: event.progress,
      phase:
        event.progress.state === "complete"
          ? ""
          : sentence(event.progress.stage),
      lastActivityAt: now,
    };
  if (event.type === "reasoning")
    return { ...turn, phase: "Thinking", lastActivityAt: now };
  if (event.type === "context" && event.context)
    return {
      ...turn,
      contextUsage: event.context,
      timeline: upsertContext(turn.timeline, event.context),
      lastActivityAt: now,
    };
  if ((event.type === "tool" || event.type === "approval") && event.tool)
    return {
      ...turn,
      tools: [
        ...turnTools(turn).filter((x) => x.id !== event.tool!.id),
        event.tool,
      ],
      timeline: upsertTool(turn.timeline, event.tool),
      lastActivityAt: now,
      lastProgressAt: now,
    };
  if (event.type === "cancelled")
    return {
      ...turn,
      phase: "",
      progress: undefined,
      lastActivityAt: now,
      completedAt: now,
    };
  if (event.type === "error") {
    const text = `Error: ${event.text || "The run failed."}`;
    return {
      ...turn,
      content: turn.content ? `${turn.content}\n\n${text}` : text,
      timeline: appendText(turn.timeline, text),
      phase: "",
      error: true,
      lastActivityAt: now,
      completedAt: now,
    };
  }
  return { ...turn, phase: "", lastActivityAt: now, completedAt: now };
}
function normalizeRestoredTurn(turn: Turn): Turn {
  const obsoleteHarnessText = [
    /(?:\n\n)?Error: Stopped by user\./g,
    /(?:\n\n)?上一步失败；诊断已保留，正在选择不同的恢复动作。/g,
    /(?:\n\n)?The previous step failed; preserving its diagnostic and choosing a different recovery action\./g,
    /(?:\n\n)?Error: 模型反复提出已被阻止的检查动作[^\n]*/g,
    /(?:\n\n)?Error: 验证未通过，随后根据诊断执行的具体修复也未成功[^\n]*/g,
  ];
  const clean = (value: string) =>
    obsoleteHarnessText
      .reduce((text, pattern) => text.replace(pattern, ""), value)
      .trim();
  const content = clean(turn.content);
  const timeline = turn.timeline
    ?.map((entry) =>
      entry.type === "text" ? { ...entry, text: clean(entry.text) } : entry,
    )
    .filter((entry) => entry.type !== "text" || entry.text);
  const normalizeTool = (tool: ToolEvent) =>
    tool.state === "error" && (tool.name === "read" || tool.name === "edit" || tool.name === "edit_lines" || tool.name === "replace_all")
      ? {
          ...tool,
          state: "done" as const,
          output: `Recovery handled: ${tool.output || "source state changed"}`,
        }
      : tool;
  const restoredTools = turn.tools?.map(normalizeTool);
  const restoredTimeline = timeline?.map((entry) =>
    entry.type === "tool"
      ? { ...entry, tool: normalizeTool(entry.tool) }
      : entry,
  );
  if (content !== turn.content)
    return {
      ...turn,
      content,
      tools: restoredTools,
      timeline: restoredTimeline,
      phase: "",
      progress: undefined,
      error: false,
    };
  const restored = {
    ...turn,
    tools: restoredTools,
    timeline: restoredTimeline,
  };
  return !turn.phase
    ? restored
    : {
        ...restored,
        phase: "",
        ...(!turn.content && turn.role === "assistant"
          ? { content: "Run interrupted.", error: true }
          : {}),
      };
}
function appendText(timeline: Turn["timeline"] = [], text: string) {
  if (!text) return timeline;
  const next = [...timeline],
    last = next.at(-1);
  if (last?.type === "text")
    next[next.length - 1] = { type: "text", text: last.text + text };
  else next.push({ type: "text", text });
  return next;
}
function upsertTool(timeline: Turn["timeline"] = [], tool: ToolEvent) {
  const index = timeline.findIndex(
    (x) => x.type === "tool" && x.tool.id === tool.id,
  );
  if (index < 0) return [...timeline, { type: "tool" as const, tool }];
  const next = [...timeline];
  next[index] = { type: "tool", tool };
  return next;
}
function upsertContext(
  timeline: Turn["timeline"] = [],
  context: NonNullable<Turn["contextUsage"]>,
) {
  if (context.state === "ready") return timeline;
  const next = [...timeline],
    lastIndex = next.length - 1,
    index = next.findLastIndex(
      (entry) =>
        entry.type === "context" && entry.context.state === "compacting",
    );
  if (context.state === "compacting" && lastIndex >= 0 && next[lastIndex]?.type === "context")
    next[lastIndex] = { type: "context", context };
  else if (context.state === "compacted" && index >= 0)
    next[index] = { type: "context", context };
  else next.push({ type: "context", context });
  return next;
}
function ContextNotice({
  value,
  language,
}: {
  value: NonNullable<Turn["contextUsage"]>;
  language: UiLanguage;
}) {
  return (
    <div class={`context-notice ${value.state}`}>
      <ListRestart />
      <span>
        {language === "zh"
          ? value.state === "compacting"
            ? "正在压缩上下文…"
            : "上下文已自动压缩"
          : value.state === "compacting"
            ? "Compacting context…"
            : "Context automatically compacted"}
      </span>
    </div>
  );
}
function ContextMeter({
  value,
  modelWindow,
  maxOutputTokens,
}: {
  value?: NonNullable<Turn["contextUsage"]>;
  modelWindow: number;
  maxOutputTokens: number;
}) {
  const configuredOutput = Math.min(
      Math.max(1, maxOutputTokens),
      modelWindow / 2,
    ),
    initialBudgetTokens = Math.max(
      2_000,
      modelWindow - configuredOutput - 4_096,
    ),
    [open, setOpen] = useState(false),
    root = useRef<HTMLDivElement>(null),
    used = value ? contextTokens(value) : 0,
    budget = value?.budgetTokens ||
      (value ? Math.ceil(value.budgetCharacters / 2.5) : initialBudgetTokens),
    percent = Math.min(100, Math.round((used / Math.max(1, budget)) * 100)),
    previousPercent = useRef(percent),
    previousAngle = previousPercent.current * 3.6,
    remaining = Math.max(0, budget - used);
  useEffect(() => {
    previousPercent.current = percent;
  }, [percent]);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
        if (!root.current?.contains(event.target as Node)) setOpen(false);
      },
      key = (event: KeyboardEvent) => {
        if (event.key === "Escape") setOpen(false);
      };
    addEventListener("pointerdown", pointer);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("pointerdown", pointer);
      removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div class="context-meter-wrap" ref={root}>
      <button
        type="button"
        class="context-meter"
        aria-label="Show context usage"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
      >
        <span
          key={`context-ring-${used}-${budget}`}
          class="context-ring"
          style={{
            "--usage-from": `${previousAngle}deg`,
            "--usage-target": `${percent * 3.6}deg`,
          }}
        />
        <small key={`context-value-${used}-${budget}`}>
          {compactCount(used)} / {compactCount(budget)}
        </small>
      </button>
      {open && (
        <div class="context-popover" role="dialog" aria-label="Context usage">
          <header>
            <span>Context</span>
            <em>{value?.exactTokens ? "Exact" : "Estimated"}</em>
          </header>
          <strong>
            {compactCount(used)} <small>/ {compactCount(budget)} tokens</small>
          </strong>
          <div class="context-progress">
            <i style={{ width: `${percent}%` }} />
          </div>
          <dl>
            <div>
              <dt>Used</dt>
              <dd>
                {used.toLocaleString()} tokens
              </dd>
            </div>
            <div>
              <dt>Before compaction</dt>
              <dd>{remaining.toLocaleString()} tokens left</dd>
            </div>
            <div>
              <dt>Active window</dt>
              <dd>{budget.toLocaleString()} tokens</dd>
            </div>
            <div>
              <dt>Model window</dt>
              <dd>{modelWindow.toLocaleString()} tokens</dd>
            </div>
          </dl>
          <p>
            Shun compacts older work before the active window fills, while
            preserving the task objective, verified sources, decisions, and key
            file snapshots.
          </p>
        </div>
      )}
    </div>
  );
}
function contextTokens(value: NonNullable<Turn["contextUsage"]>) {
  return value.usedTokens || Math.ceil(value.usedCharacters / 2.5);
}
function compactCount(value: number) {
  return value >= 1000
    ? `${(value / 1000).toFixed(1).replace(/\.0$/, "")}K`
    : String(value);
}
function thinkingStatus(
  turn: Turn,
  running: string,
  now: number,
  language: UiLanguage,
) {
  if (
    turn.id !== running ||
    !turn.phase ||
    Boolean(turn.content.trim()) ||
    turnTools(turn).some(
      (tool) => tool.state === "running" || tool.state === "waiting",
    )
  )
    return { label: "", elapsed: "", quiet: "", stalled: false };
  const startedAt = turn.startedAt || now,
    progressAt = turn.lastProgressAt || startedAt,
    elapsed = now - startedAt,
    quiet = now - progressAt,
    phase = /^(?:Thinking|Working)$/.test(turn.phase)
      ? language === "zh"
        ? "思考中"
        : "Thinking"
      : turn.phase.replace(/\.*$/, "");
  return {
    label: phase,
    elapsed: formatElapsed(elapsed),
    quiet:
      quiet >= 60_000
        ? language === "zh"
          ? `最近进展 ${formatElapsed(quiet)} 前`
          : `last progress ${formatElapsed(quiet)} ago`
        : "",
    stalled: quiet >= 120_000,
  };
}
function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000)),
    minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
function sentence(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}
