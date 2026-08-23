import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { Fragment } from "preact";
import { createPortal, memo } from "preact/compat";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import { markedMathExtension } from "./math-markdown";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowUp,
  Blocks,
  Check,
  Cable,
  ChevronDown,
  ChevronUp,
  Cloud,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileDiff,
  FileArchive,
  FileImage,
  FilePenLine,
  FileSpreadsheet,
  FileText,
  Files,
  FolderOpen,
  GitBranch,
  KeyRound,
  Languages,
  ListChecks,
  ListRestart,
  LoaderCircle,
  Minus,
  MessageCircle,
  Monitor,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Palette,
  Play,
  Presentation,
  Plus,
  Puzzle,
  RotateCcw,
  Search,
  Server,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  Trash2,
  Upload,
  X,
} from "lucide-preact";
import { accentColor, accentOptions } from "./accent";
import type {
  AgentEvent,
  AttachmentPreview,
  AttachmentRef,
  BackgroundEvent,
  BackgroundOutputChunk,
  BackgroundTask,
  Provider,
  ProviderApi,
  ProviderCatalog,
  ProviderCatalogEntry,
  ProviderModel,
  PluginState,
  PluginConnectionState,
  RepositorySnapshot,
  RunProgress,
  SavedState,
  Settings,
  SkillDocument,
  SkillState,
  Task,
  ToolEvent,
  Turn,
  UpdateState,
} from "../../shared";
import { compactCloudProviderDeployments, compactProviderModelMenu, compactResumeToolOutput, hasContinuationState, hasTaskContent, hasTaskMessages, isSoftNotFoundSource, isTaskWorkspaceLocked, keepCurrentDraft, latestProviderFailure, latestUnsentTask, nextTaskWorkspace, normalizeProviderConnection } from "../../shared";
import { completedMermaidBlockCount, feedScrollModeAfterScroll, finishTaskRun, nextRunnablePrompt, nextStreamingText, runningTurnAnchorId, settleTurnCompaction, streamedFeedScrollTop, summarizedFailureCount, taskHasActiveBackground, taskRunIsActive, turnAwaitsModelOutput, visibleWorkspaceChangeCount, type FeedScrollMode } from './task-runtime';
import { isShellTool, productToolOutputForDisplay, productToolPresentation, shellCommand } from './tool-presentation';
import logo from "./assets/shun-logo.png";

const providerLogoUrls = import.meta.glob("./assets/provider-logos/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function ProviderBrandMark({ id, name, className = "provider-letter", preserveColor = false }: { id: string; name: string; className?: string; preserveColor?: boolean }) {
  const src = providerLogoUrls[`./assets/provider-logos/${id}.svg`];
  return <span class={className}>{src ? preserveColor ? <img class="provider-brand-image" src={src} alt="" /> : <i class="provider-brand-mark" style={`--provider-logo:url("${src}")`} /> : name.slice(0, 1)}</span>;
}

function configuredProviderLogoId(provider: Provider) {
  const clue = `${provider.catalogId || ""} ${provider.kind} ${provider.name} ${provider.endpoint}`.toLowerCase(),
    aliases: Array<[RegExp, string]> = [
      [/openrouter/, "openrouter"],
      [/deepseek/, "deepseek"],
      [/anthropic|claude/, "anthropic"],
      [/google|gemini|generativelanguage/, "google"],
      [/(?:^|\s)xai(?:\s|$)|grok|api\.x\.ai/, "xai"],
      [/zhipu|bigmodel|z\.ai|(?:^|\s)zai(?:-|\s|$)/, "zai"],
      [/moonshot|kimi/, "moonshotai"],
      [/xiaomi|mimo/, "xiaomi"],
      [/minimax/, "minimax"],
      [/(?:^|\s)groq(?:\s|$)|api\.groq/, "groq"],
      [/nvidia|integrate\.api\.nvidia/, "nvidia"],
      [/bedrock/, "amazon-bedrock"],
      [/azure/, "azure"],
      [/ollama/, "ollama"],
      [/lmstudio|lm studio/, "lmstudio"],
      [/llamacpp|llama\.cpp/, "llamacpp"],
      [/(?:^|\s)vllm(?:\s|$)/, "vllm"],
      [/openai|api\.openai\.com/, "openai"],
    ];
  return aliases.find(([pattern]) => pattern.test(clue))?.[1];
}

function ConfiguredProviderMark({ provider }: { provider: Provider }) {
  const id = configuredProviderLogoId(provider);
  return id ? <ProviderBrandMark id={id} name={provider.name} className={`provider-icon ${provider.kind}`} preserveColor={id === "lmstudio"} /> : <span class={`provider-icon ${provider.kind}`}><Server /></span>;
}

function DeferredNumberInput({
  value,
  min,
  max,
  step,
  label,
  onCommit,
}: {
  value: number;
  min: number;
  max?: number;
  step: number;
  label: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value)),
    [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  const commit = (raw: string) => {
    const parsed = Number(raw),
      next = raw.trim() && Number.isFinite(parsed)
        ? Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, Math.trunc(parsed)))
        : value;
    setEditing(false);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return <input
    aria-label={label}
    type="number"
    min={min}
    max={max}
    step={step}
    value={draft}
    onFocus={() => setEditing(true)}
    onInput={(event) => setDraft(event.currentTarget.value)}
    onBlur={(event) => commit(event.currentTarget.value)}
    onKeyDown={(event) => {
      if (event.key === "Enter") event.currentTarget.blur();
    }}
  />;
}

type DeploymentTestState = { status: "testing" | "success" | "error"; message: string; latencyMs?: number };
type ToastMessage = { id: string; tone: "success" | "error" | "info"; title: string; message?: string };
type ToastInput = Omit<ToastMessage, "id">;

const feedAnchorGap = 35,
  feedStreamRevealGap = 24;

const legacyPresetProviders: Record<string, { name: string; endpoint: string }> = {
  remote: { name: "Qwen Remote", endpoint: "http://100.98.225.63:11434/v1" },
  ollama: { name: "Ollama", endpoint: "http://127.0.0.1:11434/v1" },
  lmstudio: { name: "LM Studio", endpoint: "http://127.0.0.1:1234/v1" },
  vllm: { name: "vLLM", endpoint: "http://127.0.0.1:8000/v1" },
  llamacpp: { name: "llama.cpp", endpoint: "http://127.0.0.1:8080/v1" },
  custom: { name: "Custom", endpoint: "http://127.0.0.1:8000/v1" },
};
const localProviderPresets: Array<{ id: 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm'; name: string; endpoint: string }> = [
  { id: 'ollama', name: 'Ollama', endpoint: 'http://127.0.0.1:11434/v1' },
  { id: 'lmstudio', name: 'LM Studio', endpoint: 'http://127.0.0.1:1234/v1' },
  { id: 'llamacpp', name: 'llama.cpp', endpoint: 'http://127.0.0.1:8080/v1' },
  { id: 'vllm', name: 'vLLM', endpoint: 'http://127.0.0.1:8000/v1' },
];
function isUnusedLegacyPreset(provider: Provider) {
  const preset = legacyPresetProviders[provider.id];
  return Boolean(
    preset &&
    provider.name === preset.name &&
    provider.endpoint === preset.endpoint &&
    !provider.apiKey,
  );
}
const defaults: Settings = {
  endpoint: "",
  apiKey: "",
  providerId: "",
  providers: [],
  mcpServers: [],
  plugins: [],
  skills: [],
  model: "",
  workspace: "",
  temperature: 0.2,
  maxTokens: 8192,
  contextWindow: 32768,
  autoCompact: true,
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
    attachments: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }),
  first = makeTask();

function normalizeProviderModels(provider: Provider, fallbackWindow: number): ProviderModel[] {
  const raw = Array.isArray(provider.models) ? (provider.models as unknown[]) : [];
  return raw
    .map((item): ProviderModel | null =>
      typeof item === "string"
        ? { id: item, contextWindow: provider.contextWindow || fallbackWindow, maxOutputTokens: 8192 }
        : item && typeof item === "object" && "id" in item
          ? {
              id: String((item as ProviderModel).id),
              name: (item as ProviderModel).name,
              family: (item as ProviderModel).family,
              releaseDate: (item as ProviderModel).releaseDate,
              lastUpdated: (item as ProviderModel).lastUpdated,
              contextWindow: Number((item as ProviderModel).contextWindow) || provider.contextWindow || fallbackWindow,
              maxOutputTokens: Number((item as ProviderModel).maxOutputTokens) || 8192,
              vision: (item as ProviderModel).vision,
              reasoning: (item as ProviderModel).reasoning,
              toolCall: (item as ProviderModel).toolCall,
              featured: (item as ProviderModel).featured,
              status: (item as ProviderModel).status,
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
  const resolvedAccent = accentColor(accent);
  const colors = theme === "light"
    ? { bg: "#ffffff", fg: "#1e1e1e", line: "#1e1e1e", muted: "#8d8d8d", surface: "transparent", border: "#bbbbbb" }
    : { bg: "#111111", fg: "#ececec", line: "#ececec", muted: "#9f9f9f", surface: "transparent", border: "#7a7a7a" };
  document.querySelectorAll<SVGElement>(".mermaid-view svg,.diagram-modal-stage svg").forEach((svg) => {
    for (const [key, value] of Object.entries({ ...colors, accent: resolvedAccent })) svg.style.setProperty(`--${key}`, value);
    svg.style.background = "var(--bg)";
  });
}
type SlashCommand = {
  id: string;
  name: string;
  aliases?: string[];
  label: string;
  labelZh: string;
  detail: string;
  detailZh: string;
  icon: any;
  args?: boolean;
  workspace?: boolean;
  conversation?: boolean;
  disabled?: boolean;
  skill?: SkillState;
};
const commands: SlashCommand[] = [
  { id: "archive", name: "/archive", label: "Archive", labelZh: "归档任务", detail: "Archive the current task", detailZh: "归档当前任务", icon: Archive, conversation: true },
  { id: "review", name: "/review", label: "Review changes", labelZh: "审查变更", detail: "Review current workspace changes", detailZh: "审查当前工作区变更", icon: FileDiff, workspace: true },
  { id: "compact", name: "/compact", label: "Compact", labelZh: "压缩上下文", detail: "Compact this task's context", detailZh: "压缩当前任务的上下文", icon: ListRestart, conversation: true },
  { id: "model", name: "/model", label: "Model", labelZh: "模型", detail: "Choose the active model", detailZh: "选择当前模型", icon: Cpu },
  { id: "rename", name: "/rename", aliases: ["/name"], label: "Rename", labelZh: "重命名", detail: "Rename the current task", detailZh: "重命名当前任务", icon: FilePenLine, args: true, conversation: true },
  { id: "new", name: "/new", label: "New task", labelZh: "新建任务", detail: "Start a new task", detailZh: "开始一个新任务", icon: Plus, conversation: true },
  { id: "status", name: "/status", label: "Task status", labelZh: "任务状态", detail: "Show environment, changes, and processes", detailZh: "查看环境、变更和后台程序", icon: SlidersHorizontal, conversation: true },
  { id: "plugins", name: "/plugins", label: "Plugins", labelZh: "插件", detail: "Open installed and available plugins", detailZh: "管理已安装和可用插件", icon: Blocks },
  { id: "skills", name: "/skills", label: "Skills", labelZh: "技能", detail: "Open installed Agent Skills", detailZh: "管理已安装的 Agent Skill", icon: Puzzle },
  { id: "settings", name: "/settings", label: "Settings", labelZh: "设置", detail: "Open Shun settings", detailZh: "打开 Shun 设置", icon: SettingsIcon },
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
  markedMathExtension,
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
type ImageViewport = { zoom: number; x: number; y: number };
type ImageFit = { width: number; height: number };
type ImagePan = { pointerId: number; startX: number; startY: number; originX: number; originY: number };

const initialImageViewport: ImageViewport = { zoom: 1, x: 0, y: 0 };
const initialImageFit: ImageFit = { width: 0, height: 0 };
const maxImageZoom = 8;

export function App() {
  const [settings, setSettings] = useState(defaults),
    [tasks, setTasks] = useState<Task[]>([first]),
    [currentId, setCurrentId] = useState(first.id),
    [draftByTask, setDraftByTask] = useState<Record<string, string>>({}),
    [pendingAttachmentsByTask, setPendingAttachmentsByTask] = useState<Record<string, AttachmentRef[]>>({}),
    [selectedSkillByTask, setSelectedSkillByTask] = useState<Record<string, SkillState>>({}),
    [availableSkills, setAvailableSkills] = useState<SkillState[]>([]),
    [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreview | null>(null),
    [previewLoading, setPreviewLoading] = useState(false),
    [imageViewport, setImageViewport] = useState<ImageViewport>(initialImageViewport),
    [imageFit, setImageFit] = useState<ImageFit>(initialImageFit),
    [imagePanning, setImagePanning] = useState(false),
    [attachmentDrag, setAttachmentDrag] = useState(false),
    [runningByTask, setRunningByTask] = useState<Record<string, string>>({}),
    [queued, setQueued] = useState<
      { id: string; taskId: string; text: string; attachments?: AttachmentRef[]; skill?: SkillState }[]
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
    [taskMenuPosition, setTaskMenuPosition] = useState<{ left: number; top: number } | null>(null),
    [renameTarget, setRenameTarget] = useState<{ id: string; value: string } | null>(null),
    [confirmAction, setConfirmAction] = useState<{
      title: string;
      body: string;
      label: string;
      action: () => void | Promise<void>;
    } | null>(null),
    [showSettings, setShowSettings] = useState(false),
    [showPlugins, setShowPlugins] = useState(false),
    [toasts, setToasts] = useState<ToastMessage[]>([]),
    [appUpdate, setAppUpdate] = useState<UpdateState | null>(null),
    [showEnvironment, setShowEnvironment] = useState(false),
    [diff, setDiff] = useState<string | null>(null),
    [repository, setRepository] = useState<RepositorySnapshot | null>(null),
    [workspaceReviews, setWorkspaceReviews] = useState<Record<string, { text: string; count: number }>>({}),
    [modelMenu, setModelMenu] = useState(false),
    [showOlderModels, setShowOlderModels] = useState(false),
    [projectMenu, setProjectMenu] = useState(false),
    [projectQuery, setProjectQuery] = useState(""),
    [slashDismissed, setSlashDismissed] = useState(false),
    [slashIndex, setSlashIndex] = useState(0),
    [compactingTaskId, setCompactingTaskId] = useState(""),
    [pluginHubTab, setPluginHubTab] = useState<"plugins" | "skills">("plugins"),
    [sidebarOpen, setSidebarOpen] = useState(true),
    [fullscreen, setFullscreen] = useState(false),
    [collapsedWorkspaces, setCollapsedWorkspaces] = useState<string[]>([]),
    [hydrated, setHydrated] = useState(false),
    feed = useRef<HTMLDivElement>(null),
    slashMenu = useRef<HTMLDivElement>(null),
    feedScrollMode = useRef<FeedScrollMode>('follow-bottom'),
    programmaticScrollTop = useRef<number | null>(null),
    input = useRef<HTMLTextAreaElement>(null),
    searchInput = useRef<HTMLInputElement>(null),
    imagePreviewStage = useRef<HTMLDivElement>(null),
    imagePreviewImage = useRef<HTMLImageElement>(null),
    imagePan = useRef<ImagePan | null>(null),
    pendingScrollTurn = useRef(""),
    runLayoutTask = useRef(""),
    deltas = useRef(new Map<string, string>()),
    titleFallbacks = useRef(new Map<string, { taskId: string; title: string }>()),
    reasoningHeartbeats = useRef(new Map<string, number>()),
    visibleRunningTools = useRef(new Set<string>()),
    pendingToolUpdates = useRef(new Map<string, AgentEvent>()),
    toolUpdateTimer = useRef(0),
    taskCleanup = useRef(new Map<string, Promise<boolean>>()),
    toastTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>()),
    attachmentPreviewRequest = useRef(0),
    frame = useRef(0);
  const dismissToast = (id: string) => {
      const timer = toastTimers.current.get(id);
      if (timer) clearTimeout(timer);
      toastTimers.current.delete(id);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    },
    notify = (input: ToastInput) => {
      const id = uid();
      setToasts((current) => [...current.slice(-2), { ...input, id }]);
      toastTimers.current.set(id, setTimeout(() => dismissToast(id), input.tone === "error" ? 6000 : 3800));
      return id;
    };
  const task = tasks.find((x) => x.id === currentId) || tasks[0],
    text = draftByTask[currentId] || "",
    pendingAttachments = pendingAttachmentsByTask[currentId] || [],
    selectedSkill = selectedSkillByTask[currentId],
    running = runningByTask[currentId] || "",
    backgrounds = backgroundByTask[currentId] || [],
    activeBackgroundCount = backgrounds.filter((item) => ['starting', 'running', 'stopping'].includes(item.state)).length,
    turns = task?.turns || [],
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
    providerModels = provider ? normalizeProviderModels(provider, settings.contextWindow) : [],
    composerModels = compactProviderModelMenu(providerModels.length ? providerModels : models.map((id) => ({ id, contextWindow: settings.contextWindow, maxOutputTokens: settings.maxTokens })), settings.model, provider?.kind === "cloud"),
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
    hasConversation = hasTaskMessages(task),
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
    matchingCommands: SlashCommand[] =
      !slashDismissed && text.startsWith("/") && !/[\s\n]/.test(text)
        ? [
            ...commands
            .filter((command) => !command.workspace || Boolean(task?.workspace))
            .filter((command) => !command.conversation || hasConversation)
            .filter((command) => [command.name, ...(command.aliases || [])].some((name) => name.startsWith(text.toLowerCase())))
            .map((command) => ({
              ...command,
              detail: command.id === "model"
                ? (settings.model || command.detail)
                : command.id === "compact" && activeContext
                  ? `${command.detail} (${contextPercent}% used)`
                  : command.detail,
              detailZh: command.id === "model"
                ? (settings.model || command.detailZh)
                : command.id === "compact" && activeContext
                  ? `${command.detailZh}（已使用 ${contextPercent}%）`
                  : command.detailZh,
              disabled: (Boolean(running) && ["archive", "compact", "review"].includes(command.id)) || (command.id === "compact" && compactingTaskId === currentId),
            })),
            ...availableSkills
              .filter((skill) => {
                const query = text.slice(1).toLowerCase();
                return !query || skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query);
              })
              .map((skill) => ({
                id: skill.id,
                name: `/skill:${skill.name}`,
                label: skill.name,
                labelZh: skill.name,
                detail: skill.description,
                detailZh: skill.description,
                icon: Puzzle,
                skill,
              })),
          ]
        : [];
  useEffect(() => {
    window.shun.load().then((saved: SavedState | null) => {
      if (saved?.settings && Array.isArray(saved.tasks)) {
        const restored = saved.tasks.map((task) => ({
            ...task,
            turns: task.turns.map((turn) => normalizeRestoredTurn(turn)),
          })).filter(hasTaskContent),
          tasks = restored.length ? restored : [makeTask(saved.settings.workspace || "")],
          selected = tasks.find((x) => x.id === saved.currentId) || tasks[0],
          configured = saved.settings,
          savedContext =
            Number(configured.contextWindow) || defaults.contextWindow,
          configuredProviders = (configured.providers || [])
            .filter((item) => item && !isUnusedLegacyPreset(item))
            .map((item) => {
              const connection = normalizeProviderConnection(item),
                normalizedModels = normalizeProviderModels(item, savedContext),
                compacted = item.kind === "cloud" ? compactCloudProviderDeployments(normalizedModels, configured.model) : { models: normalizedModels };
              return {
                ...item,
                ...connection,
                contextWindow: Number(item.contextWindow) || savedContext,
                models: compacted.models,
              };
            }),
          importedProvider = !configuredProviders.length && configured.endpoint &&
            !Object.values(legacyPresetProviders).some((preset) => preset.endpoint === configured.endpoint)
              ? [{
                  id: uid(),
                  name: "Model provider",
                  kind: "custom" as const,
                  endpoint: configured.endpoint,
                  apiKey: configured.apiKey || "",
                  contextWindow: savedContext,
                  models: configured.model ? [{
                    id: configured.model,
                    contextWindow: savedContext,
                    maxOutputTokens: Number(configured.maxTokens) || 8192,
                  }] : [],
                }]
              : [],
          merged = configuredProviders.length ? configuredProviders : importedProvider,
          active =
            merged.find((item) => item.id === configured.providerId) ||
            merged[0],
          activeModels = active ? normalizeProviderModels(active, savedContext) : [],
          restoredModel = activeModels.some((item) => item.id === configured.model) ? configured.model : activeModels[0]?.id || "";
        setSettings({
          ...defaults,
          ...configured,
          autoCompact: true,
          endpoint: active?.endpoint || "",
          apiKey: active?.apiKey || "",
          providerId: active?.id || "",
          model: active ? restoredModel : "",
          contextWindow: active?.contextWindow || savedContext,
          providers: merged,
          mcpServers: Array.isArray(configured.mcpServers) ? configured.mcpServers : [],
          plugins: Array.isArray(configured.plugins) ? configured.plugins : [],
          skills: Array.isArray(configured.skills) ? configured.skills : [],
        });
        setTasks(tasks);
        setDraftByTask(Object.fromEntries(tasks
          .filter((item) => Boolean(item.draft))
          .map((item) => [item.id, item.draft!] as const)));
        setPendingAttachmentsByTask(Object.fromEntries(tasks.map((item) => {
          const used = new Set(item.turns.flatMap((turn) => turn.attachments?.map((attachment) => attachment.id) || []));
          return [item.id, (item.attachments || []).filter((attachment) => !used.has(attachment.id))];
        }).filter(([, items]) => (items as AttachmentRef[]).length)));
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
    if (hydrated && !settings.providers.length) setShowSettings(true);
  }, [hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    let live = true;
    window.shun.skills({ ...settings, workspace: task?.workspace || "" })
      .then((items) => {
        if (!live) return;
        const enabled = items.filter((skill) => skill.installed && skill.enabled),
          allowed = task?.capabilities?.skillIds
            ? new Set(task.capabilities.skillIds.map((id) => id.toLowerCase()))
            : undefined,
          unique = new Map<string, SkillState>();
        for (const skill of enabled) {
          if (allowed && !allowed.has(skill.id.toLowerCase()) && !allowed.has(skill.name.toLowerCase()) && !allowed.has(`skill:${skill.name.toLowerCase()}`)) continue;
          if (!unique.has(skill.id)) unique.set(skill.id, skill);
        }
        setAvailableSkills([...unique.values()].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => live && setAvailableSkills([]));
    return () => { live = false; };
  }, [hydrated, task?.workspace, task?.capabilities?.skillIds, settings.plugins, settings.skills, settings.mcpServers]);
  useEffect(() => {
    const active = settings.providers.find((item) => item.id === settings.providerId) || settings.providers[0],
      discoverLocalModels = active && ["ollama", "lmstudio", "vllm", "llamacpp"].includes(active.kind);
    if (!settings.endpoint.trim() || !discoverLocalModels) {
      setModels([]);
      return;
    }
    let live = true,
      lastProbeAt = 0,
      probe = () =>
        (lastProbeAt = Date.now(), window.shun
          .models(settings.endpoint, settings.apiKey, active.api)
          .then((x) => live && setModels(x))),
      probeWhenVisible = () => {
        if (document.visibilityState === "visible" && Date.now() - lastProbeAt >= 10 * 60_000) probe();
      };
    probe();
    window.addEventListener("focus", probeWhenVisible);
    document.addEventListener("visibilitychange", probeWhenVisible);
    return () => {
      live = false;
      window.removeEventListener("focus", probeWhenVisible);
      document.removeEventListener("visibilitychange", probeWhenVisible);
    };
  }, [settings.endpoint, settings.apiKey, settings.providerId, provider?.api, provider?.kind, showSettings]);
  useEffect(() => {
    if (!models.length) return;
    setSettings((x) => {
      const active = x.providers.find((item) => item.id === x.providerId) || x.providers[0],
        unavailable = !active;
      if (unavailable) return x;
      const
        configured = normalizeProviderModels(active, x.contextWindow),
        merged: ProviderModel[] = [
          ...models.map<ProviderModel>((id) => configured.find((item) => item.id === id) || {
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
      const accent = accentColor(settings.accent);
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.accent = settings.accent || "blue";
      document.documentElement.style.setProperty("--accent", accent);
      document.documentElement.style.setProperty("--accent-soft", `${accent}22`);
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
  useEffect(() => () => {
    for (const timer of toastTimers.current.values()) clearTimeout(timer);
    toastTimers.current.clear();
    if (frame.current) window.clearTimeout(frame.current);
    if (toolUpdateTimer.current) window.clearTimeout(toolUpdateTimer.current);
  }, []);
  useEffect(() => {
    let live = true;
    window.shun.windowState().then((state) => live && setFullscreen(state.fullscreen));
    const unsubscribe = window.shun.onWindowState((state) => live && setFullscreen(state.fullscreen));
    return () => { live = false; unsubscribe(); };
  }, []);
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
    if (!hydrated || !task?.workspace) {
      setRepository(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      window.shun.repository(task.workspace).then((snapshot) => {
        if (live) setRepository(snapshot);
      });
    }, running ? 800 : 120);
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
  function revealRunningTurn(node: HTMLDivElement, runId: string) {
    if (feedScrollMode.current !== 'follow-stream') return;
    const latest = node.querySelector<HTMLElement>(`[data-turn-id="${runId}"]`),
      composerEdge = node.parentElement?.querySelector<HTMLElement>('.dock > .context-strip, .dock > .composer');
    if (!latest || !composerEdge) return;
    const target = streamedFeedScrollTop({
      scrollTop: node.scrollTop,
      latestBottom: latest.getBoundingClientRect().bottom,
      composerTop: composerEdge.getBoundingClientRect().top,
      revealGap: feedStreamRevealGap,
      maxScrollTop: Math.max(0, node.scrollHeight - node.clientHeight),
    });
    if (Math.abs(node.scrollTop - target) < 1) return;
    programmaticScrollTop.current = target;
    node.scrollTop = target;
    programmaticScrollTop.current = node.scrollTop;
  }
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
            target = Math.max(0, node.scrollTop + anchorTop - feedTop - feedAnchorGap);
          programmaticScrollTop.current = target;
          node.scrollTop = target;
          programmaticScrollTop.current = node.scrollTop;
          if (Math.abs(node.scrollTop - target) < 2) pendingScrollTurn.current = "";
        }
      } else if (feedScrollMode.current === 'follow-bottom') {
        programmaticScrollTop.current = node.scrollHeight;
        node.scrollTop = node.scrollHeight;
        programmaticScrollTop.current = node.scrollTop;
      } else if (feedScrollMode.current === 'follow-stream' && running) {
        revealRunningTurn(node, running);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [turns, running]);
  useEffect(() => {
    const node = feed.current;
    if (!node || !running) return;
    const latest = node.querySelector<HTMLElement>(`[data-turn-id="${running}"]`),
      composerEdge = node.parentElement?.querySelector<HTMLElement>('.dock > .context-strip, .dock > .composer');
    if (!latest || !composerEdge) return;
    let id = 0;
    const follow = () => {
      cancelAnimationFrame(id);
      id = requestAnimationFrame(() => revealRunningTurn(node, running));
    }, observer = new ResizeObserver(follow);
    observer.observe(latest);
    observer.observe(composerEdge);
    observer.observe(node);
    return () => {
      cancelAnimationFrame(id);
      observer.disconnect();
    };
  }, [currentId, running]);
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = "auto";
    input.current.style.height = `${Math.min(input.current.scrollHeight, 190)}px`;
  }, [text]);
  useEffect(() => {
    setSlashDismissed(false);
    setSlashIndex(0);
  }, [text]);
  useEffect(() => {
    if (slashIndex >= matchingCommands.length) setSlashIndex(Math.max(0, matchingCommands.length - 1));
  }, [matchingCommands.length, slashIndex]);
  useLayoutEffect(() => {
    const menu = slashMenu.current,
      selected = menu?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    if (!menu || !selected) return;
    const top = selected.offsetTop,
      bottom = top + selected.offsetHeight,
      viewportTop = menu.scrollTop,
      viewportBottom = viewportTop + menu.clientHeight;
    if (top < viewportTop + 4) menu.scrollTop = Math.max(0, top - 4);
    else if (bottom > viewportBottom - 4) menu.scrollTop = bottom - menu.clientHeight + 4;
  }, [slashIndex, matchingCommands.length]);
  useEffect(() => {
    if (attachmentPreview?.mode !== "image") return;
    const stage = imagePreviewStage.current;
    if (!stage) return;
    const fit = () => fitImageToStage();
    const frame = requestAnimationFrame(fit), observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [attachmentPreview?.attachment.id, attachmentPreview?.mode]);
  useLayoutEffect(() => {
    if (!searching) return;
    searchInput.current?.focus({ preventScroll: true });
    const focusFrame = requestAnimationFrame(() =>
      searchInput.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(focusFrame);
  }, [searching]);
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
        if (showSettings) return;
        setSearching(false);
        setQuery("");
        setDiff(null);
        setShowSettings(false);
        setShowEnvironment(false);
        setModelMenu(false);
        setProjectMenu(false);
        setRenameTarget(null);
        setSlashDismissed(true);
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [running, currentId, showSettings]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!target.closest(".project-menu,.project-trigger,.crumb:not(.locked)"))
        setProjectMenu(false);
      if (!target.closest(".item-menu,.item-menu-trigger")) setItemMenu("");
      if (!target.closest(".model-picker,.model-btn")) setModelMenu(false);
      if (!target.closest(".slash-menu,.composer textarea"))
        setSlashDismissed(true);
    };
    addEventListener("pointerdown", dismiss);
    return () => removeEventListener("pointerdown", dismiss);
  }, []);
  useEffect(() => {
    if (!modelMenu) setShowOlderModels(false);
  }, [modelMenu]);
  useEffect(() => setShowOlderModels(false), [settings.providerId]);
  useEffect(() => {
    const next = nextRunnablePrompt(queued, runningByTask);
    if (!next) return;
    const target = tasks.find((x) => x.id === next.taskId);
    setQueued((items) => items.filter((item) => item.id !== next.id));
    if (target) runPrompt(next.text, target.turns, target, undefined, next.attachments || [], next.skill);
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
    update(taskId, (item) => ({
      ...item,
      draft: value || undefined,
    }));
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
        frame.current = window.setTimeout(() => {
          const pending = new Map(deltas.current);
          deltas.current.clear();
          frame.current = 0;
          setTasks((xs) => applyPending(xs, pending));
        }, 50);
      return;
    }
    if (event.type === "reasoning") {
      const now = performance.now(),
        previous = reasoningHeartbeats.current.get(event.id) || 0;
      if (previous && now - previous < 1000) return;
      reasoningHeartbeats.current.set(event.id, now);
    }
    if (event.type === "tool" && event.tool?.state === "running") {
      const key = `${event.id}:${event.tool.id}`;
      if (!visibleRunningTools.current.has(key)) {
        visibleRunningTools.current.add(key);
      } else {
        pendingToolUpdates.current.set(key, event);
        if (!toolUpdateTimer.current) toolUpdateTimer.current = window.setTimeout(() => {
          const pending = [...pendingToolUpdates.current.values()];
          pendingToolUpdates.current.clear();
          toolUpdateTimer.current = 0;
          setTasks((items) => applyBufferedEvents(items, pending));
        }, 100);
        return;
      }
    }
    if (event.type === "tool" && event.tool) {
      const key = `${event.id}:${event.tool.id}`;
      visibleRunningTools.current.delete(key);
      pendingToolUpdates.current.delete(key);
    }
    if (
      event.type === "done" ||
      event.type === "cancelled" ||
      event.type === "error"
    ) {
      titleFallbacks.current.delete(event.id);
      reasoningHeartbeats.current.delete(event.id);
      for (const key of visibleRunningTools.current)
        if (key.startsWith(`${event.id}:`)) visibleRunningTools.current.delete(key);
      for (const key of pendingToolUpdates.current.keys())
        if (key.startsWith(`${event.id}:`)) pendingToolUpdates.current.delete(key);
      if (!pendingToolUpdates.current.size && toolUpdateTimer.current) {
        window.clearTimeout(toolUpdateTimer.current);
        toolUpdateTimer.current = 0;
      }
      setRunningByTask((active) => finishTaskRun(active, event.id));
    }
    const pending = new Map(deltas.current);
    deltas.current.clear();
    if (frame.current) window.clearTimeout(frame.current);
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
                turns: task.turns.map((turn) =>
                  turn.id === event.id ? settleTurnCompaction(turn) : turn,
                ),
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
    setShowPlugins(false);
    const draft = latestUnsentTask(tasks, workspace);
    if (draft) {
      selectTask(draft);
      setShowArchived(false);
      setProjectMenu(false);
      setItemMenu("");
      setTimeout(() => input.current?.focus());
      return;
    }
    const next = makeTask(nextTaskWorkspace(workspace, task?.workspace, settings.workspace));
    setTasks((xs) => [next, ...xs.filter(hasTaskContent)]);
    setCurrentId(next.id);
    setShowArchived(false);
    setProjectMenu(false);
    setItemMenu("");
    feedScrollMode.current = 'follow-bottom';
    pendingScrollTurn.current = "";
    runLayoutTask.current = "";
    setTimeout(() => input.current?.focus());
  }
  function selectTask(next: Task) {
    setShowPlugins(false);
    const activeRun = runningByTask[next.id] || "";
    setTasks((items) => items.filter((item) => item.id === next.id || hasTaskContent(item)));
    setCurrentId(next.id);
    setShowArchived(Boolean(next.archivedAt));
    setSearching(false);
    setItemMenu("");
    setSettings((value) => ({ ...value, workspace: next.workspace }));
    feedScrollMode.current = activeRun ? 'follow-stream' : 'follow-bottom';
    pendingScrollTurn.current = activeRun ? runningTurnAnchorId(next.turns, activeRun) : "";
    runLayoutTask.current = activeRun ? next.id : "";
  }
  function isRunning(item: Task) {
    return taskRunIsActive(runningByTask, item.id);
  }
  function hasRunningBackground(item: Task) {
    return taskHasActiveBackground(backgroundByTask[item.id] || []);
  }
  function commitTasks(next: Task[], selectedId?: string) {
    if (!next.length) next = [makeTask(settings.workspace || "")];
    setTasks(next);
    const ids = new Set(next.map((task) => task.id));
    setDraftByTask((drafts) => Object.fromEntries(Object.entries(drafts).filter(([id]) => ids.has(id))));
    setPendingAttachmentsByTask((attachments) => Object.fromEntries(Object.entries(attachments).filter(([id]) => ids.has(id))));
    setSelectedSkillByTask((skills) => Object.fromEntries(Object.entries(skills).filter(([id]) => ids.has(id))));
    setRunningByTask((runs) => Object.fromEntries(Object.entries(runs).filter(([id]) => ids.has(id))));
    setBackgroundByTask((processes) => Object.fromEntries(Object.entries(processes).filter(([id]) => ids.has(id))));
    setQueued((queue) =>
      queue.filter((item) => next.some((task) => task.id === item.taskId)),
    );
    const selected =
      (selectedId ? next.find((x) => x.id === selectedId) : undefined) ||
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
    const updated = tasks.map((x) =>
      x.id === id
        ? {
            ...x,
            archivedAt: archived ? Date.now() : undefined,
            updatedAt: Date.now(),
          }
        : x,
    );
    if (archived && id === currentId) {
      const next = makeTask(item.workspace || settings.workspace || "");
      commitTasks([next, ...updated.filter(hasTaskContent)], next.id);
      setShowArchived(false);
      setProjectMenu(false);
      setItemMenu("");
      feedScrollMode.current = 'follow-bottom';
      pendingScrollTurn.current = "";
      setTimeout(() => input.current?.focus());
      return;
    }
    commitTasks(updated);
  }
  function deleteTask(id: string) {
    const item = tasks.find((x) => x.id === id);
    if (!item || isRunning(item)) return;
    if (hasRunningBackground(item)) {
      setItemMenu("");
      selectTask(item);
      setShowEnvironment(true);
      notify({ tone: "info", title: zh ? "请先停止后台程序" : "Stop background processes first", message: zh ? "该任务的后台程序仍在运行。" : "This task still owns an active background process." });
      return;
    }
    setItemMenu("");
    setTaskMenuPosition(null);
    setConfirmAction({
      title: zh ? "删除任务？" : "Delete task?",
      body: zh
        ? `“${item.title}”的任务记录、附件和缓存将被删除；本地文件不受影响。`
        : `Deletes “${item.title}”, its attachments, and cached data. Local files are not affected.`,
      label: zh ? "删除任务" : "Delete task",
      action: () => {
        commitTasks(tasks.filter((x) => x.id !== id));
        void window.shun.deleteTaskData(id).catch((error) => {
          notify({ tone: "error", title: zh ? "部分任务缓存数据未能移除" : "Some cached task data could not be removed", message: error instanceof Error ? error.message : String(error) });
        });
      },
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
    const backgroundOwner = members.find(hasRunningBackground);
    if (backgroundOwner) {
      setItemMenu("");
      selectTask(backgroundOwner);
      setShowEnvironment(true);
      notify({ tone: "info", title: zh ? "请先停止后台程序" : "Stop background processes first", message: zh ? "该项目仍有后台程序正在运行。" : "This project still owns an active background process." });
      return;
    }
    const name = workspace.split("/").pop();
    setItemMenu("");
    setTaskMenuPosition(null);
    setConfirmAction({
      title: zh ? `从 Shun 中删除 ${name}？` : `Delete ${name} from Shun?`,
      body: zh
        ? `将删除 ${members.length} 条任务记录、附件和缓存；项目文件不受影响。`
        : `Deletes ${members.length} task record${members.length === 1 ? "" : "s"}, attachments, and cached data. Project files are not affected.`,
      label: zh ? "删除项目记录" : "Delete project records",
      action: () => {
        commitTasks(tasks.filter((x) => x.workspace !== workspace));
        void Promise.all(members.map((item) => window.shun.deleteTaskData(item.id))).catch((error) => {
          notify({ tone: "error", title: zh ? "部分项目缓存数据未能移除" : "Some cached project data could not be removed", message: error instanceof Error ? error.message : String(error) });
        });
      },
    });
  }
  function setDraftWorkspace(path: string) {
    if (isTaskWorkspaceLocked(task)) return;
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
    if (!task?.workspace || isTaskWorkspaceLocked(task)) return;
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
    if (isTaskWorkspaceLocked(task)) return;
    const path = await window.shun.chooseWorkspace();
    if (path) setDraftWorkspace(path);
  }
  function rememberAttachments(items: AttachmentRef[], targetId = currentId) {
    if (!items.length) return;
    update(targetId, (item) => ({ ...item, attachments: [...(item.attachments || []), ...items.filter(next => !(item.attachments || []).some(existing => existing.id === next.id))], updatedAt: Date.now() }));
    setPendingAttachmentsByTask((pending) => ({ ...pending, [targetId]: [...(pending[targetId] || []), ...items.filter(next => !(pending[targetId] || []).some(existing => existing.id === next.id))] }));
  }
  async function chooseAttachments() {
    if (!task) return;
    try { rememberAttachments(await window.shun.chooseAttachments(task.id)); }
    catch (error) { notify({ tone: "error", title: zh ? "无法添加文件" : "Could not attach files", message: error instanceof Error ? error.message : String(error) }); }
  }
  async function importDroppedAttachments(files: File[]) {
    if (!task) return;
    const paths = files.map(file => window.shun.pathForFile(file)).filter(Boolean);
    if (!paths.length) return;
    try { rememberAttachments(await window.shun.importAttachments(task.id, paths)); }
    catch (error) { notify({ tone: "error", title: zh ? "无法添加文件" : "Could not attach files", message: error instanceof Error ? error.message : String(error) }); }
  }
  async function importClipboardImages(event: ClipboardEvent) {
    if (!task || !event.clipboardData) return;
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!files.length) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      const payload = await Promise.all(files.map(async (file, index) => ({
        name: file.name || `Screenshot-${stamp}${index ? `-${index + 1}` : ""}.${file.type.split("/")[1]?.replace("jpeg", "jpg") || "png"}`,
        data: await file.arrayBuffer(),
      })));
      rememberAttachments(await window.shun.importAttachmentData(task.id, payload));
    } catch (error) {
      notify({ tone: "error", title: zh ? "无法粘贴图片" : "Could not paste image", message: error instanceof Error ? error.message : String(error) });
    }
  }
  async function removePendingAttachment(item: AttachmentRef) {
    setPendingAttachmentsByTask((pending) => ({ ...pending, [currentId]: (pending[currentId] || []).filter(existing => existing.id !== item.id) }));
    const used = task?.turns.some(turn => turn.attachments?.some(existing => existing.id === item.id));
    if (!used) {
      update(currentId, (current) => ({ ...current, attachments: (current.attachments || []).filter(existing => existing.id !== item.id), updatedAt: Date.now() }));
      await window.shun.removeAttachment(currentId, item.id);
    }
  }
  function resetImageViewport() {
    imagePan.current = null;
    setImagePanning(false);
    setImageViewport(initialImageViewport);
  }
  function fitImageToStage() {
    const stage = imagePreviewStage.current,
      image = imagePreviewImage.current;
    if (!stage || !image?.naturalWidth || !image.naturalHeight) return;
    const style = getComputedStyle(stage),
      availableWidth = Math.max(1, stage.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)),
      availableHeight = Math.max(1, stage.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0)),
      ratio = Math.min(1, availableWidth / image.naturalWidth, availableHeight / image.naturalHeight),
      width = Math.max(1, Math.floor(image.naturalWidth * ratio)),
      height = Math.max(1, Math.floor(image.naturalHeight * ratio));
    setImageFit((current) => current.width === width && current.height === height ? current : { width, height });
    setImageViewport((current) => {
      if (current.zoom <= 1) return initialImageViewport;
      const maxX = Math.max(0, (width * current.zoom - stage.clientWidth) / 2),
        maxY = Math.max(0, (height * current.zoom - stage.clientHeight) / 2);
      return { ...current, x: Math.max(-maxX, Math.min(maxX, current.x)), y: Math.max(-maxY, Math.min(maxY, current.y)) };
    });
  }
  function clampImageViewport(next: ImageViewport): ImageViewport {
    const stage = imagePreviewStage.current,
      image = imagePreviewImage.current;
    if (!stage || !image || next.zoom <= 1) return next.zoom <= 1 ? initialImageViewport : next;
    const maxX = Math.max(0, (image.offsetWidth * next.zoom - stage.clientWidth) / 2),
      maxY = Math.max(0, (image.offsetHeight * next.zoom - stage.clientHeight) / 2);
    return { zoom: next.zoom, x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y)) };
  }
  function zoomImageBy(factor: number, clientX?: number, clientY?: number) {
    setImageViewport((current) => {
      const zoom = Math.max(1, Math.min(maxImageZoom, current.zoom * factor));
      if (zoom === 1) return initialImageViewport;
      const ratio = zoom / current.zoom,
        stage = imagePreviewStage.current;
      let x = current.x * ratio,
        y = current.y * ratio;
      if (stage && clientX !== undefined && clientY !== undefined) {
        const rect = stage.getBoundingClientRect(),
          localX = clientX - rect.left - rect.width / 2,
          localY = clientY - rect.top - rect.height / 2;
        x = localX - (localX - current.x) * ratio;
        y = localY - (localY - current.y) * ratio;
      }
      return clampImageViewport({ zoom, x, y });
    });
  }
  function beginImagePan(event: PointerEvent) {
    if (event.button !== 0 || imageViewport.zoom <= 1) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    imagePan.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: imageViewport.x, originY: imageViewport.y };
    setImagePanning(true);
  }
  function moveImagePan(event: PointerEvent) {
    const pan = imagePan.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    setImageViewport((current) => clampImageViewport({ ...current, x: pan.originX + event.clientX - pan.startX, y: pan.originY + event.clientY - pan.startY }));
  }
  function endImagePan(event: PointerEvent) {
    if (imagePan.current?.pointerId !== event.pointerId) return;
    imagePan.current = null;
    setImagePanning(false);
  }
  async function openAttachmentPreview(item: AttachmentRef, page = 1) {
    if (!attachmentCanPreview(item)) return;
    const request = ++attachmentPreviewRequest.current;
    resetImageViewport();
    setImageFit(initialImageFit);
    setPreviewLoading(true);
    try {
      const preview = await window.shun.previewAttachment(item.taskId, item.id, page, "display");
      if (request === attachmentPreviewRequest.current) setAttachmentPreview(preview);
    }
    catch (error) { notify({ tone: "error", title: zh ? "无法预览文件" : "Could not preview file", message: error instanceof Error ? error.message : String(error) }); }
    finally { if (request === attachmentPreviewRequest.current) setPreviewLoading(false); }
  }
  function closeAttachmentPreview() {
    attachmentPreviewRequest.current += 1;
    resetImageViewport();
    setAttachmentPreview(null);
    setPreviewLoading(false);
  }
  async function copyAttachmentImage(item: AttachmentRef) {
    try {
      await window.shun.copyAttachmentImage(item.taskId, item.id);
      notify({ tone: "success", title: zh ? "图片已复制" : "Image copied" });
    } catch (error) {
      notify({ tone: "error", title: zh ? "复制图片失败" : "Could not copy image", message: error instanceof Error ? error.message : String(error) });
    }
  }
  async function saveAttachmentImage(item: AttachmentRef) {
    try {
      const saved = await window.shun.saveAttachmentImage(item.taskId, item.id);
      if (saved) notify({ tone: "success", title: zh ? "图片已保存" : "Image saved" });
    } catch (error) {
      notify({ tone: "error", title: zh ? "保存图片失败" : "Could not save image", message: error instanceof Error ? error.message : String(error) });
    }
  }
  function runPrompt(
    prompt: string,
    base = turns,
    target = task,
    replay?: { history: Turn[]; evidence: Turn[] },
    attached: AttachmentRef[] = pendingAttachmentsByTask[target?.id || ""] || [],
    skill?: SkillState,
    action?:
      | { kind: "interrupt" }
      | { kind: "revision"; targetMessageId: string; revisedFromId: string },
  ) {
    if ((!prompt.trim() && !attached.length) || (!action && runningByTask[target?.id || ""]) || !target) return;
    const cleanup = taskCleanup.current.get(target.id);
    if (cleanup) {
      void cleanup.then(() => runPrompt(prompt, base, target, replay, attached, skill, action)).catch((error) => {
        notify({ tone: "error", title: "Task cleanup did not finish", message: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (!settings.providers.length || !settings.endpoint.trim() || !settings.model.trim()) {
      setShowSettings(true);
      return;
    }
    const generateTitle = !replay && target.title === "New task" && !base.some((turn) => turn.role === "user"),
      fallbackTitle = (prompt.trim() || attached.map(item => item.name).join(', ')).replace(/\s+/g, " ").slice(0, 46),
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
            {
              id: userId,
              role: "user",
              content: prompt.trim(),
              attachments: attached,
              ...(skill ? { skillId: skill.id } : {}),
              ...(action?.kind === "revision" ? { revisedFromId: action.revisedFromId } : {}),
            },
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
      feedScrollMode.current = 'follow-stream';
      pendingScrollTurn.current = userId || runId;
      runLayoutTask.current = target.id;
    }
    update(target.id, (x) => ({
      ...x,
      title:
        generateTitle && x.title === "New task"
          ? fallbackTitle
          : x.title,
      turns: next,
      ...(action?.kind === "revision" ? { summary: undefined, compactedAt: undefined } : {}),
      updatedAt: Date.now(),
    }));
    if (target.id === currentId) setText("");
    setPendingAttachmentsByTask((pending) => ({ ...pending, [target.id]: [] }));
    setRunningByTask((active) => ({ ...active, [target.id]: runId }));
    const skillInvocationName = skill?.origin === "plugin" ? skill.id : skill?.name,
      requestText = skillInvocationName ? `/skill:${skillInvocationName} ${prompt.trim()}`.trim() : prompt.trim();
    if (skill) setSelectedSkillByTask((selected) => {
      if (selected[target.id]?.id !== skill.id) return selected;
      const next = { ...selected };
      delete next[target.id];
      return next;
    });
    const request = {
      id: runId,
      taskId: target.id,
      messageId: userId || undefined,
      text: requestText,
      attachments: attached,
      history: conversation
        .filter((x) => x.content)
        .map(({ role, content }) => ({ role, content })),
      settings: { ...settings, workspace: target.workspace },
      capabilities: skill ? { ...target.capabilities, skillIds: [skill.id] } : target.capabilities,
      ...(generateTitle ? { generateTitle: true } : {}),
      summary: action?.kind === "revision" ? undefined : target.summary,
      compactedAt: action?.kind === "revision" ? undefined : target.compactedAt,
      ...(action?.kind === "revision" ? { revision: { targetMessageId: action.targetMessageId } } : {}),
      web: webHistory(evidence),
      ...(replay || hasContinuationState(evidence)
        ? { resume: { ...resumeHistory(evidence), intent: replay ? "retry" as const : "followup" as const } }
        : {}),
    };
    if (action?.kind === "interrupt") {
      void window.shun.interrupt(request).catch((error) => {
        notify({ tone: "error", title: zh ? "无法立即发送" : "Could not send now", message: error instanceof Error ? error.message : String(error) });
      });
    } else if (action?.kind === "revision") {
      void window.shun.revise(request).catch((error) => {
        notify({ tone: "error", title: zh ? "无法从修改处继续" : "Could not continue from edit", message: error instanceof Error ? error.message : String(error) });
      });
    } else window.shun.run(request);
  }
  function executeSlashCommand(prompt: string) {
    if (prompt === "/settings") {
      setShowSettings(true);
      setText("");
      return true;
    }
    if (prompt === "/model") {
      setModelMenu(true);
      setText("");
      return true;
    }
    if (prompt === "/new") {
      newTask();
      return true;
    }
    const rename = prompt.match(/^\/(?:rename|name)\s+(.+)$/);
    if (rename) {
      update(currentId, (x) => ({
        ...x,
        title: rename[1].trim() || x.title,
        updatedAt: Date.now(),
      }));
      setText("");
      return true;
    }
    if (prompt.startsWith("/compact")) {
      setText("");
      void compact(prompt.slice(8).trim());
      return true;
    }
    if (prompt === "/archive") {
      setText("");
      if (!running) archiveTask(currentId, true);
      return true;
    }
    if (prompt === "/review") {
      setText("");
      if (!running && task?.workspace) void review();
      return true;
    }
    if (prompt === "/status") {
      setText("");
      setShowEnvironment(true);
      return true;
    }
    if (prompt === "/plugins" || prompt === "/skills") {
      setText("");
      setPluginHubTab(prompt === "/skills" ? "skills" : "plugins");
      setShowPlugins(true);
      setSearching(false);
      setItemMenu("");
      return true;
    }
    if (prompt === "/copy") {
      const last = [...turns]
        .reverse()
        .find((x) => x.role === "assistant" && x.content);
      if (last) void copyText(last.content);
      setText("");
      return true;
    }
    if (prompt === "/export") {
      setText("");
      void exportTask();
      return true;
    }
    if (prompt === "/import") {
      setText("");
      void importTask();
      return true;
    }
    if (prompt === "/clear" && !running) {
      update(currentId, (x) => ({
        ...x,
        turns: [],
        attachments: [],
        summary: undefined,
        compactedAt: undefined,
        updatedAt: Date.now(),
      }));
      setPendingAttachmentsByTask((pending) => ({ ...pending, [currentId]: [] }));
      const cleanup = window.shun.deleteTaskData(currentId);
      taskCleanup.current.set(currentId, cleanup);
      void cleanup.catch((error) => notify({ tone: "error", title: "Some cached task data could not be removed", message: error instanceof Error ? error.message : String(error) })).finally(() => {
        if (taskCleanup.current.get(currentId) === cleanup) taskCleanup.current.delete(currentId);
      });
      setText("");
      return true;
    }
    return false;
  }
  function selectSlashCommand(command: (typeof matchingCommands)[number]) {
    if (command.disabled) return;
    if (command.skill) {
      setSelectedSkillByTask((selected) => ({ ...selected, [currentId]: command.skill! }));
      setText("");
      requestAnimationFrame(() => input.current?.focus());
      return;
    }
    if (command.args) {
      setText(`${command.name} `);
      requestAnimationFrame(() => input.current?.focus());
      return;
    }
    executeSlashCommand(command.name);
  }
  function submit(immediate = false) {
    const prompt = text.trim();
    if (!prompt && !pendingAttachments.length) return;
    if (prompt && executeSlashCommand(prompt)) return;
    if (running) {
      if (immediate) {
        runPrompt(prompt, turns, task, undefined, pendingAttachments, selectedSkill, { kind: "interrupt" });
        return;
      }
      setQueued((x) => [...x, { id: uid(), taskId: currentId, text: prompt, attachments: pendingAttachments, skill: selectedSkill }]);
      setText("");
      setPendingAttachmentsByTask((pending) => ({ ...pending, [currentId]: [] }));
      setSelectedSkillByTask((selected) => {
        const next = { ...selected };
        delete next[currentId];
        return next;
      });
      return;
    }
    runPrompt(prompt, turns, task, undefined, pendingAttachments, selectedSkill);
  }
  function sendQueuedNow(item: { id: string; taskId: string; text: string; attachments?: AttachmentRef[]; skill?: SkillState }) {
    const target = tasks.find((candidate) => candidate.id === item.taskId);
    if (!target) return;
    setQueued((items) => items.filter((candidate) => candidate.id !== item.id));
    runPrompt(item.text, target.turns, target, undefined, item.attachments || [], item.skill, { kind: "interrupt" });
  }
  function editQueuedPrompt(item: { id: string; taskId: string; text: string; attachments?: AttachmentRef[]; skill?: SkillState }) {
    if (item.taskId !== currentId) return;
    const draft = text,
      draftAttachments = pendingAttachments,
      draftSkill = selectedSkill,
      hasDraft = Boolean(draft.trim() || draftAttachments.length || draftSkill);
    setQueued((items) => items.flatMap((candidate) => candidate.id !== item.id
      ? [candidate]
      : hasDraft
        ? [{ id: uid(), taskId: currentId, text: draft, attachments: draftAttachments, skill: draftSkill }]
        : []));
    setText(item.text);
    setPendingAttachmentsByTask((pending) => ({ ...pending, [currentId]: item.attachments || [] }));
    setSelectedSkillByTask((selected) => {
      const next = { ...selected };
      if (item.skill) next[currentId] = item.skill;
      else delete next[currentId];
      return next;
    });
    requestAnimationFrame(() => input.current?.focus());
  }
  async function revisePrompt(messageId: string, value: string) {
    if (!task) return;
    const index = task.turns.findIndex((turn) => turn.id === messageId && turn.role === "user"),
      original = task.turns[index];
    if (index < 0 || !original || (!value.trim() && !original.attachments?.length)) return;
    let preview;
    try {
      preview = await window.shun.revisionPreview(task.id, messageId, task.workspace);
    } catch (error) {
      notify({ tone: "error", title: zh ? "无法检查回退点" : "Could not inspect checkpoint", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!preview.available || !preview.complete) {
      notify({
        tone: "error",
        title: zh ? "这条消息无法安全编辑" : "This message cannot be edited safely",
        message: preview.warning || (zh ? "没有完整的文件检查点。" : "No complete workspace checkpoint is available."),
      });
      return;
    }
    const laterMessages = task.turns.length - index - 1,
      changedFiles = preview.changedFiles.length,
      originalSkill = original.skillId ? availableSkills.find((skill) => skill.id === original.skillId) : undefined,
      apply = () => {
        setQueued((items) => items.filter((item) => item.taskId !== task.id));
        runPrompt(
          value,
          task.turns.slice(0, index),
          task,
          undefined,
          original.attachments || [],
          originalSkill,
          { kind: "revision", targetMessageId: messageId, revisedFromId: messageId },
        );
      };
    if (!laterMessages && !changedFiles && !running) {
      apply();
      return;
    }
    const details = zh
      ? `将移除后续 ${laterMessages} 条消息${changedFiles ? `，并恢复 ${changedFiles} 个已变更文件` : ""}。外部副作用（例如已发送消息或已发布内容）不会撤销。`
      : `This removes ${laterMessages} later message${laterMessages === 1 ? "" : "s"}${changedFiles ? ` and restores ${changedFiles} changed file${changedFiles === 1 ? "" : "s"}` : ""}. External side effects, such as sent messages or published content, are not undone.`;
    setConfirmAction({
      title: zh ? "从这里重新开始？" : "Restart from this message?",
      body: details,
      label: zh ? "回退并继续" : "Revert and continue",
      action: apply,
    });
  }
  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify({ tone: "success", title: zh ? "已复制" : "Copied" });
    } catch {
      notify({ tone: "error", title: zh ? "复制失败" : "Copy failed" });
    }
  }
  async function compact(instructions = "") {
    if (running) {
      notify({ tone: "info", title: zh ? "任务仍在运行" : "Task is still running", message: zh ? "请等待当前回复完成后再压缩上下文。" : "Wait for the current response to finish before compacting." });
      return;
    }
    if (compactingTaskId === currentId) {
      notify({ tone: "info", title: zh ? "正在压缩上下文" : "Compacting context" });
      return;
    }
    if (turns.length < 2) {
      notify({ tone: "info", title: zh ? "暂时无需压缩" : "Nothing to compact", message: zh ? "当前任务的上下文已经很精简。" : "This task's context is already compact." });
      return;
    }
    const target = task;
    const progressToast = notify({
      tone: "info",
      title: zh ? "正在压缩上下文…" : "Compacting context…",
      message: zh ? `当前已使用 ${contextPercent}%` : `${contextPercent}% currently used`,
    });
    setCompactingTaskId(target.id);
    try {
      const summary = await window.shun.compact(
        {
          id: uid(),
          taskId: target.id,
          text: "",
          history,
          settings: { ...settings, workspace: target.workspace },
          capabilities: target.capabilities,
        },
        instructions,
      );
      dismissToast(progressToast);
      if (!summary) {
        notify({ tone: "info", title: zh ? "暂时无需压缩" : "Nothing to compact", message: zh ? "当前任务的上下文已经很精简。" : "This task's context is already compact." });
        return;
      }
      update(target.id, (x) => ({
        ...x,
        summary,
        compactedAt: x.turns.length,
        updatedAt: Date.now(),
      }));
      notify({ tone: "success", title: zh ? "上下文已压缩" : "Context compacted" });
    } catch (error) {
      dismissToast(progressToast);
      const message = error instanceof Error ? error.message : String(error);
      if (/nothing to compact|already compacted|session too small/i.test(message)) {
        notify({ tone: "info", title: zh ? "暂时无需压缩" : "Nothing to compact", message: zh ? "当前任务的上下文已经很精简。" : "This task's context is already compact." });
      } else {
        notify({ tone: "error", title: zh ? "上下文压缩失败" : "Could not compact context", message });
      }
    } finally {
      setCompactingTaskId((id) => id === target.id ? "" : id);
    }
  }
  function retry(id: string) {
    const index = turns.findIndex((x) => x.id === id),
      userIndex = turns.findLastIndex((x, i) => i < index && x.role === "user"),
      user = turns[userIndex];
    if (index >= 0 && user)
      runPrompt(user.content, turns, task, {
        history: turns.slice(0, userIndex),
        evidence: turns.slice(0, index + 1),
      }, user.attachments || []);
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
    <main class={`shell ${sidebarOpen ? "" : "sidebar-collapsed"} ${fullscreen ? "window-fullscreen" : ""}`}>
      <aside class="sidebar">
        <button
          class="sidebar-toggle"
          aria-label="Hide sidebar"
          title="Hide sidebar"
          onClick={() => setSidebarOpen(false)}
        >
          <PanelLeftClose />
        </button>
        <button class="new" onClick={() => newTask()}>
          <Plus />
          <span>{zh ? "新建任务" : "New task"}</span>
          <kbd>⌘N</kbd>
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
            <kbd>⌘K</kbd>
          </button>
          <button
            class={showPlugins ? "active" : ""}
            onClick={() => {
              setPluginHubTab("plugins");
              setShowPlugins(true);
              setSearching(false);
              setItemMenu("");
            }}
          >
            <Blocks />
            <span>{zh ? "插件" : "Plugins"}</span>
          </button>
          <button
            class={!showPlugins && showArchived ? "active" : ""}
            onClick={() => {
              setShowPlugins(false);
              setShowArchived((x) => !x);
              setItemMenu("");
            }}
          >
            {showArchived ? <ArrowLeft /> : <Archive />}
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
                        title={zh ? `在 ${group.workspace.split("/").pop()} 中新建任务` : `New task in ${group.workspace.split("/").pop()}`}
                        onClick={() => newTask(group.workspace)}
                      >
                        <Plus />
                      </button>
                    )}
                    <button
                      class="item-menu-trigger"
                      aria-label={zh ? "项目操作" : "Project actions"}
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
                          {zh ? (navigator.platform.includes("Mac") ? "在 Finder 中显示" : "打开文件夹") : (navigator.platform.includes("Mac") ? "Show in Finder" : "Open folder")}
                        </button>
                        {showArchived ? (
                          <button
                            onClick={() =>
                              archiveProject(group.workspace, false)
                            }
                          >
                            <ArchiveRestore />
                            {zh ? "恢复项目" : "Restore project"}
                          </button>
                        ) : (
                          <button
                            onClick={() =>
                              archiveProject(group.workspace, true)
                            }
                            disabled={group.tasks.some(isRunning)}
                          >
                            <Archive />
                            {zh ? "归档项目" : "Archive project"}
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
                          {zh ? "删除项目" : "Delete project"}
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
                      class={`task ${!showPlugins && item.id === currentId ? "active" : ""}`}
                      onClick={() => selectTask(item)}
                    >
                      <span class="task-title">{zh && item.title === "New task" ? "新建任务" : item.title}</span>
                      {isRunning(item) ? (
                        <span class="task-spinner loading-spinner" role="status" aria-label={zh ? "正在运行" : "Running"}>
                          <LoaderCircle aria-hidden="true" />
                        </span>
                      ) : (
                        <small>{relative(item.updatedAt, uiLanguage)}</small>
                      )}
                    </button>
                    <button
                      class="item-menu-trigger task-actions-trigger"
                      aria-label={zh ? "任务操作" : "Task actions"}
                      aria-expanded={itemMenu === `task:${item.id}`}
                      disabled={isRunning(item)}
                      onClick={(e) => {
                        e.stopPropagation();
                        const trigger = e.currentTarget.getBoundingClientRect(),
                          list = e.currentTarget.closest(".tasks")?.getBoundingClientRect(),
                          spaceAbove = list ? trigger.top - list.top : trigger.top,
                          spaceBelow = list ? list.bottom - trigger.bottom : innerHeight - trigger.bottom,
                          opening = itemMenu !== `task:${item.id}`,
                          direction = spaceBelow >= 116 || spaceBelow >= spaceAbove ? "down" : "up",
                          menuWidth = 168,
                          menuHeight = 102;
                        if (!opening) {
                          setItemMenu("");
                          setTaskMenuPosition(null);
                          return;
                        }
                        setTaskMenuDirection(direction);
                        setTaskMenuPosition({
                          left: Math.max(10, Math.min(innerWidth - menuWidth - 10, trigger.left - 8)),
                          top: direction === "down" ? trigger.bottom + 5 : trigger.top - menuHeight - 5,
                        });
                        setItemMenu(`task:${item.id}`);
                      }}
                    >
                      <MoreHorizontal />
                    </button>
                    {itemMenu === `task:${item.id}` && taskMenuPosition && createPortal(
                      <div
                        class={`item-menu task-actions task-actions-popover menu-${taskMenuDirection}`}
                        style={{ left: `${taskMenuPosition.left}px`, top: `${taskMenuPosition.top}px` }}
                      >
                        <button onClick={() => beginRename(item)}>
                          <FilePenLine />
                          {zh ? "重命名" : "Rename"}
                        </button>
                        {item.archivedAt ? (
                          <button onClick={() => archiveTask(item.id, false)}>
                            <ArchiveRestore />
                            {zh ? "恢复" : "Restore"}
                          </button>
                        ) : (
                          <button onClick={() => archiveTask(item.id, true)}>
                            <Archive />
                            {zh ? "归档" : "Archive"}
                          </button>
                        )}
                        <button
                          class="danger"
                          onClick={() => deleteTask(item.id)}
                        >
                          <Trash2 />
                          {zh ? "删除" : "Delete"}
                        </button>
                      </div>,
                      document.body,
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
          {showUpdate ? (
            <button
              class={`sidebar-update ${appUpdate.status}`}
              disabled={appUpdate.status === "downloading"}
              aria-label={appUpdate.status === "ready" ? (zh ? "重启并安装更新" : "Restart and install update") : (zh ? "更新 Shun" : "Update Shun")}
              title={appUpdate.message || (appUpdate.targetVersion ? `${zh ? "新版本" : "Version"} ${appUpdate.targetVersion}` : undefined)}
              onClick={activateUpdate}
            >
              {appUpdate.status === "downloading" ? <LoaderCircle class="loading-spinner" /> : <Download />}
              <span>{appUpdate.status === "downloading"
                ? `${appUpdate.percent || 0}%`
                : appUpdate.status === "ready"
                  ? (zh ? "重启更新" : "Restart")
                  : appUpdate.status === "error"
                    ? (zh ? "重试更新" : "Retry")
                    : `${zh ? "更新" : "Update"}${appUpdate.targetVersion ? ` v${appUpdate.targetVersion}` : ""}`}</span>
            </button>
          ) : appUpdate?.currentVersion ? (
            <span class={`sidebar-version${import.meta.env.DEV ? " development" : ""}`} aria-label={`${zh ? "当前版本" : "Current version"} ${appUpdate.currentVersion}`}>
              v{appUpdate.currentVersion}
            </span>
          ) : null}
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
        {showPlugins ? (
          <PluginHub
            value={settings}
            update={setSettings}
            notify={notify}
            language={uiLanguage}
            initialTab={pluginHubTab}
            sidebarOpen={sidebarOpen}
            revealSidebar={() => setSidebarOpen(true)}
          />
        ) : (
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
                    onClick={(event) => {
                      event.stopPropagation();
                      const key = `header:${task.id}`,
                        opening = itemMenu !== key,
                        trigger = event.currentTarget.getBoundingClientRect(),
                        menuWidth = 168;
                      if (!opening) {
                        setItemMenu("");
                        setTaskMenuPosition(null);
                        return;
                      }
                      setTaskMenuDirection("down");
                      setTaskMenuPosition({
                        left: Math.max(10, Math.min(innerWidth - menuWidth - 10, trigger.left - 8)),
                        top: trigger.bottom + 5,
                      });
                      setItemMenu(key);
                    }}
                  >
                    <MoreHorizontal />
                  </button>
                )}
                {task && itemMenu === `header:${task.id}` && taskMenuPosition && createPortal(
                  <div
                    class="item-menu header-task-menu task-actions-popover"
                    style={{ left: `${taskMenuPosition.left}px`, top: `${taskMenuPosition.top}px` }}
                  >
                    <button onClick={() => beginRename(task)}>
                      <FilePenLine />
                      {zh ? "重命名" : "Rename"}
                    </button>
                    {task.archivedAt ? (
                      <button onClick={() => archiveTask(task.id, false)}>
                        <ArchiveRestore />
                        {zh ? "恢复" : "Restore"}
                      </button>
                    ) : (
                      <button onClick={() => archiveTask(task.id, true)}>
                        <Archive />
                        {zh ? "归档" : "Archive"}
                      </button>
                    )}
                    <button class="danger" onClick={() => deleteTask(task.id)}>
                      <Trash2 />
                      {zh ? "删除" : "Delete"}
                    </button>
                  </div>,
                  document.body,
                )}
                </div>
              )}
              <div class="header-actions">
                {repository && <button
                  class="repository-branch"
                  aria-label={zh ? "查看 Git 工作区变更" : "Review Git workspace changes"}
                  title={repository.upstream
                    ? `${repository.head} → ${repository.upstream} · ↑${repository.ahead} ↓${repository.behind}`
                    : repository.head}
                  onClick={() => void review()}
                >
                  <GitBranch />
                  <span>{repository.head || (zh ? "未命名分支" : "unnamed")}</span>
                  {(repository.ahead > 0 || repository.behind > 0) && <small>↑{repository.ahead} ↓{repository.behind}</small>}
                  {repository.files.length > 0 && <em>{repository.files.length}</em>}
                </button>}
                <button
                  class={`background-trigger ${activeBackgroundCount ? "active" : ""}`}
                  aria-label={zh ? "查看当前对话环境" : "View current task environment"}
                  title={zh ? "环境" : "Environment"}
                  aria-expanded={showEnvironment}
                  onClick={() => setShowEnvironment((open) => !open)}
                >
                  <SlidersHorizontal />
                  {activeBackgroundCount > 0 && <em>{activeBackgroundCount}</em>}
                </button>
              </div>
            </header>
            <div
              class={`feed ${runLayoutTask.current === currentId ? "run-anchored" : ""} ${!turns.length ? "empty-state" : ""}`}
              ref={feed}
              onWheel={() => {
                feedScrollMode.current = 'free';
                programmaticScrollTop.current = null;
              }}
              onTouchStart={() => {
                feedScrollMode.current = 'free';
                programmaticScrollTop.current = null;
              }}
              onScroll={(e) => {
                const node = e.currentTarget;
                const expected = programmaticScrollTop.current,
                  programmatic = expected !== null && Math.abs(node.scrollTop - expected) < 2;
                if (programmatic) programmaticScrollTop.current = null;
                else if (expected !== null) programmaticScrollTop.current = null;
                const nextMode = feedScrollModeAfterScroll(
                  feedScrollMode.current,
                  programmatic,
                );
                feedScrollMode.current = nextMode;
              }}
            >
              {!turns.length && (
                <div class="empty">
                  <BrandMark hero />
                  <h1>
                    {task?.workspace
                      ? (zh
                          ? <>我们要在 <span>{workspace}</span> 中构建什么？</>
                          : <>What should we build in <span>{workspace}</span>?</>)
                      : (zh ? "我们要构建什么？" : "What should we build?")}
                  </h1>
                </div>
              )}
              {!!turns.length && (
                <TaskHistory
                  key={currentId}
                  turns={turns}
                  attachments={task?.attachments || []}
                  running={running}
                  language={uiLanguage}
                  retry={retry}
                  revise={revisePrompt}
                  copyText={copyText}
                  openAttachment={openAttachmentPreview}
                />
              )}
            </div>
            <div class="dock">
              {projectMenu && !isTaskWorkspaceLocked(task) && (
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
                    language={uiLanguage}
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
                      <div key={x.id}>
                  <span>{uiLanguage === 'zh' ? '已排队' : 'Queued'}</span>
                  <p title={x.text || x.attachments?.map(item => item.name).join(", ")}>{x.text || x.attachments?.map(item => item.name).join(", ")}</p>
                  <button
                    class="queue-edit"
                    title={uiLanguage === 'zh' ? '拉回输入框编辑' : 'Return to composer and edit'}
                    aria-label={uiLanguage === 'zh' ? '编辑这条排队消息' : 'Edit queued message'}
                    onClick={() => editQueuedPrompt(x)}
                  >
                    <FilePenLine />
                  </button>
                  <button
                    class="queue-send-now"
                    title={uiLanguage === 'zh' ? '停止当前回复并立即发送' : 'Stop the current response and send now'}
                    aria-label={uiLanguage === 'zh' ? '立即发送这条消息' : 'Send this message now'}
                    onClick={() => sendQueuedNow(x)}
                  >
                    <ArrowUp />
                  </button>
                  <button
                    aria-label={
                      uiLanguage === 'zh'
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
                <div ref={slashMenu} class="slash-menu" role="listbox" aria-label={zh ? "命令" : "Commands"}>
                  {matchingCommands.map((command, index) => {
                    const Icon = command.icon;
                    return (
                    <Fragment key={command.id}>
                    {command.skill && !matchingCommands[index - 1]?.skill && <div class="slash-menu-section">{zh ? "Skills" : "Skills"}</div>}
                    <button
                      key={command.id}
                      type="button"
                      role="option"
                      aria-selected={index === slashIndex}
                      disabled={command.disabled}
                      class={index === slashIndex ? "selected" : ""}
                      onPointerMove={() => setSlashIndex(index)}
                      onClick={() => {
                        selectSlashCommand(command);
                      }}
                    >
                      <Icon />
                      <span>
                        <b>{zh ? command.labelZh : command.label}</b>
                        {!command.skill && <code>{command.name}</code>}
                      </span>
                      <small>{zh ? command.detailZh : command.detail}</small>
                    </button>
                    </Fragment>
                  )})}
                </div>
              )}
              <div
                class={`composer ${attachmentDrag ? "attachment-drag" : ""}`}
                onDragEnter={(event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); setAttachmentDrag(true); } }}
                onDragOver={(event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setAttachmentDrag(false); }}
                onDrop={(event) => { event.preventDefault(); setAttachmentDrag(false); void importDroppedAttachments(Array.from(event.dataTransfer?.files || [])); }}
              >
                {attachmentDrag && <div class="attachment-drop-hint"><Upload />{zh ? "拖放文件到这里" : "Drop files here"}</div>}
                {selectedSkill && <div class="selected-skill-chip"><span class={`plugin-logo selected-skill-logo ${selectedSkill.icon || "plugin"}`} aria-hidden="true"><PluginLogoGlyph icon={selectedSkill.icon || "plugin"} /></span><b>{selectedSkill.name}</b><button type="button" aria-label={zh ? `取消 ${selectedSkill.name}` : `Remove ${selectedSkill.name}`} onClick={() => setSelectedSkillByTask((selected) => { const next = { ...selected }; delete next[currentId]; return next; })}><X /></button></div>}
                {!!pendingAttachments.length && <AttachmentCards items={pendingAttachments} remove={(item) => void removePendingAttachment(item)} open={(item) => void openAttachmentPreview(item)} compact={false} />}
                {modelMenu && (
                  <div class="picker model-picker">
                    {composerModels.primary.map(
                      (model) => (
                        <button
                          class={model.id === settings.model ? "active" : ""}
                          onClick={() => {
                            setSettings((x) => ({ ...x, model: model.id, contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens }));
                            setModelMenu(false);
                          }}
                        >
                          <Cpu />
                          <span>
                            <b>{model.name || model.id}</b>
                            <small>{provider?.name || "Provider"}</small>
                          </span>
                          <Check />
                        </button>
                      ),
                    )}
                    {!!composerModels.older.length && <button class={`model-more ${showOlderModels ? "open" : ""}`} onClick={() => setShowOlderModels((current) => !current)}><ListRestart /><span><b>{zh ? "更多模型" : "More models"}</b><small>{composerModels.older.length} {zh ? "个历史或次要模型" : "older or secondary"}</small></span><ChevronDown /></button>}
                    {showOlderModels && <div class="model-picker-history">{composerModels.older.map((model) => <button class={model.id === settings.model ? "active" : ""} onClick={() => { setSettings((x) => ({ ...x, model: model.id, contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens })); setModelMenu(false); }}><Cpu /><span><b>{model.name || model.id}</b><small>{provider?.name || "Provider"}</small></span><Check /></button>)}</div>}
                    <div class="model-picker-separator" />
                    <button
                      onClick={() => {
                        setModelMenu(false);
                        setShowSettings(true);
                      }}
                    >
                      <SettingsIcon />
                      <span>
                        <b>{zh ? "模型设置" : "Model settings"}</b>
                      </span>
                    </button>
                  </div>
                )}
                <textarea
                  ref={input}
                  rows={1}
                  value={text}
                  placeholder={
                    task?.workspace
                      ? (zh ? "让 Shun 构建、检查或修复…" : "Ask Shun to build, inspect, or fix…")
                      : (zh ? "询问 Shun…" : "Ask Shun anything…")
                  }
                  onInput={(e) => setText(e.currentTarget.value)}
                  onPaste={(event) => void importClipboardImages(event)}
                  onKeyDown={(e) => {
                    if (matchingCommands.length) {
                      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        const direction = e.key === "ArrowDown" ? 1 : -1;
                        setSlashIndex((index) => (index + direction + matchingCommands.length) % matchingCommands.length);
                        return;
                      }
                      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                        e.preventDefault();
                        selectSlashCommand(matchingCommands[slashIndex] || matchingCommands[0]);
                        return;
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submit(Boolean(running && (e.metaKey || e.ctrlKey)));
                    }
                  }}
                />
                <div class="bar">
                  <button class="attach-file" title={zh ? "添加文件" : "Attach files"} aria-label={zh ? "添加文件" : "Attach files"} onClick={() => void chooseAttachments()}>
                    <Paperclip />
                  </button>
                  <ContextMeter
                    value={activeContext}
                    modelWindow={settings.contextWindow}
                    maxOutputTokens={settings.maxTokens}
                    language={uiLanguage}
                  />
                  <button
                    class="model-btn"
                    aria-expanded={modelMenu}
                    onClick={() => {
                      setModelMenu(!modelMenu);
                    }}
                  >
                    <span class="model-label">{settings.model || (zh ? "配置模型" : "Set up model")}</span>
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
                      disabled={!text.trim() && !pendingAttachments.length}
                      onClick={() => submit()}
                    >
                      <ArrowUp />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </section>
      {showSettings && (
        <SettingsPage
          value={settings}
          models={models}
          close={() => setShowSettings(false)}
          update={setSettings}
          exportTask={exportTask}
          importTask={importTask}
          notify={notify}
        />
      )}
      {showEnvironment && (
        <EnvironmentPanel
          items={backgrounds}
          output={backgroundOutput}
          task={task}
          repository={repository}
          changeCount={changeCount}
          attachments={task?.attachments || []}
          language={uiLanguage}
          close={() => setShowEnvironment(false)}
          review={() => { setShowEnvironment(false); void review(); }}
          openAttachment={(attachment) => { setShowEnvironment(false); void openAttachmentPreview(attachment); }}
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
              <button onClick={() => setConfirmAction(null)}>{zh ? "取消" : "Cancel"}</button>
              <button
                class="danger"
                onClick={() => {
                  const action = confirmAction.action;
                  setConfirmAction(null);
                  void action();
                }}
              >
                {confirmAction.label}
              </button>
            </div>
          </div>
        </div>
      )}
      {(attachmentPreview || previewLoading) && (
        <div class="veil attachment-preview-veil" onPointerDown={(event) => { if (event.target === event.currentTarget) closeAttachmentPreview(); }}>
          <section
            class={`attachment-preview-dialog ${navigator.platform.includes("Mac") ? "mac-titlebar" : ""} ${attachmentPreview?.mode === "image" ? "image-preview" : "text-preview"}`}
            role="dialog"
            aria-modal="true"
            aria-label={zh ? "附件预览" : "Attachment preview"}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header>
              <span class="attachment-preview-title"><i><AttachmentTypeIcon item={attachmentPreview?.attachment} /></i><span><b>{attachmentPreview?.attachment.name || (zh ? "正在载入…" : "Loading…")}</b>{attachmentPreview && <small>{attachmentLabel(attachmentPreview.attachment)} · {formatAttachmentSize(attachmentPreview.attachment.size)}</small>}</span></span>
              <span class="attachment-preview-actions">
                {attachmentPreview?.attachment.kind === "image" && <><span class="attachment-preview-zoom"><button disabled={imageViewport.zoom <= 1} title={zh ? "缩小" : "Zoom out"} aria-label={zh ? "缩小" : "Zoom out"} onClick={() => zoomImageBy(1 / 1.25)}><Minus /></button><button class="attachment-preview-zoom-value" title={zh ? "适应窗口" : "Fit to window"} aria-label={zh ? "适应窗口" : "Fit to window"} onClick={resetImageViewport}>{Math.round(imageViewport.zoom * 100)}%</button><button disabled={imageViewport.zoom >= maxImageZoom} title={zh ? "放大" : "Zoom in"} aria-label={zh ? "放大" : "Zoom in"} onClick={() => zoomImageBy(1.25)}><Plus /></button></span><button title={zh ? "复制图片" : "Copy Image"} aria-label={zh ? "复制图片" : "Copy Image"} onClick={() => void copyAttachmentImage(attachmentPreview.attachment)}><Copy /></button><button title={zh ? "图片另存为" : "Save Image As"} aria-label={zh ? "图片另存为" : "Save Image As"} onClick={() => void saveAttachmentImage(attachmentPreview.attachment)}><Download /></button></>}
                <button aria-label={zh ? "关闭" : "Close"} onClick={closeAttachmentPreview}><X /></button>
              </span>
            </header>
            <div class={`attachment-preview-body ${attachmentPreview?.mode || "loading"}`}>
              {previewLoading && !attachmentPreview ? <LoaderCircle class="attachment-preview-spinner loading-spinner" /> : attachmentPreview?.mode === 'image' ? <div ref={imagePreviewStage} class={`attachment-image-stage ${imageViewport.zoom > 1 ? "zoomed" : ""} ${imagePanning ? "panning" : ""}`} onWheel={(event) => { event.preventDefault(); zoomImageBy(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY); }} onPointerDown={beginImagePan} onPointerMove={moveImagePan} onPointerUp={endImagePan} onPointerCancel={endImagePan} onDblClick={resetImageViewport}><img ref={imagePreviewImage} draggable={false} src={`data:${attachmentPreview.mimeType};base64,${attachmentPreview.data}`} alt={attachmentPreview.attachment.name} style={{ width: imageFit.width ? `${imageFit.width}px` : "auto", height: imageFit.height ? `${imageFit.height}px` : "auto", transform: `translate3d(${imageViewport.x}px,${imageViewport.y}px,0) scale(${imageViewport.zoom})` }} onLoad={() => { resetImageViewport(); fitImageToStage(); }} onDragStart={(event) => event.preventDefault()} onContextMenu={(event) => { event.preventDefault(); window.shun.showAttachmentImageMenu(attachmentPreview.attachment.taskId, attachmentPreview.attachment.id); }} /></div> : <pre>{attachmentPreview?.content || attachmentPreview?.warning || (zh ? "没有可预览的内容。" : "No previewable content.")}</pre>}
            </div>
            {attachmentPreview?.pages && attachmentPreview.pages > 1 && <footer><button disabled={(attachmentPreview.page || 1) <= 1 || previewLoading} onClick={() => void openAttachmentPreview(attachmentPreview.attachment, (attachmentPreview.page || 1) - 1)}><ChevronUp />{zh ? "上一页" : "Previous"}</button><span>{attachmentPreview.page || 1} / {attachmentPreview.pages}</span><button disabled={(attachmentPreview.page || 1) >= attachmentPreview.pages || previewLoading} onClick={() => void openAttachmentPreview(attachmentPreview.attachment, (attachmentPreview.page || 1) + 1)}>{zh ? "下一页" : "Next"}<ChevronDown /></button></footer>}
          </section>
        </div>
      )}
      <ToastViewport items={toasts} />
    </main>
  );
}

function ToastViewport({ items }: { items: ToastMessage[] }) {
  return <div class="toast-viewport" aria-live="polite" aria-relevant="additions">
    {items.map((toast) => <section class={`app-toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
      <span class="toast-mark">{toast.tone === "success" ? <Check /> : toast.tone === "error" ? <X /> : <span />}</span>
      <span class="toast-copy"><b>{toast.title}</b>{toast.message && <span class="toast-detail">{toast.message}</span>}</span>
    </section>)}
  </div>;
}

function EnvironmentPanel({
  items,
  output,
  task,
  repository,
  changeCount,
  attachments,
  language,
  close,
  review,
  openAttachment,
  stop,
}: {
  items: BackgroundTask[];
  output: Record<string, BackgroundOutputChunk[]>;
  task?: Task;
  repository: RepositorySnapshot | null;
  changeCount: number;
  attachments: AttachmentRef[];
  language: UiLanguage;
  close: () => void;
  review: () => void;
  openAttachment: (attachment: AttachmentRef) => void;
  stop: (item: BackgroundTask) => void;
}) {
  const activeItems = items.filter((item) => ['starting', 'running', 'stopping'].includes(item.state)),
    now = useElapsedClock(activeItems.length > 0),
    zh = language === 'zh',
    [expandedId, setExpandedId] = useState<string | null>(null),
    activeCount = activeItems.length,
    workspaceName = task?.workspace.split('/').pop() || (zh ? '无项目' : 'No project'),
    status: Record<BackgroundTask['state'], string> = zh
      ? { starting: '启动中', running: '运行中', stopping: '停止中', stopped: '已停止', exited: '已退出', failed: '失败' }
      : { starting: 'Starting', running: 'Running', stopping: 'Stopping', stopped: 'Stopped', exited: 'Exited', failed: 'Failed' };
  return (
    <div class="background-popover-layer" onPointerDown={(event) => event.target === event.currentTarget && close()}>
      <section class="background-manager" role="dialog" aria-label={zh ? '当前对话环境' : 'Current task environment'} onPointerDown={(event) => event.stopPropagation()}>
        <header>
          <span><b>{zh ? '环境' : 'Environment'}</b></span>
        </header>
        <div class="background-manager-list">
          <div class={`environment-context${activeItems.length > 0 ? ' has-processes' : ''}`}>
            <button disabled={!task?.workspace} onClick={review}><FileDiff /><span>{zh ? '更改' : 'Changes'}</span><em>{changeCount}</em></button>
            <div><FolderOpen /><span>{workspaceName}</span><small>{zh ? '本地' : 'Local'}</small></div>
            {repository && <div><GitBranch /><span>{repository.head || (zh ? '未命名分支' : 'Unnamed branch')}</span>{(repository.ahead > 0 || repository.behind > 0) && <small>↑{repository.ahead} ↓{repository.behind}</small>}</div>}
          </div>
          {activeItems.length > 0 && <div class="background-section-label"><span>{zh ? '后台程序' : 'Background processes'}</span><small>{activeCount}</small></div>}
          {activeItems.map((item) => {
            const active = ['starting', 'running', 'stopping'].includes(item.state),
              seconds = Math.max(0, Math.floor(((item.finishedAt || now) - (item.startedAt || item.createdAt)) / 1000)),
              tail = (output[item.id] || []).slice(-16).map((chunk) => chunk.text).join('').trim(),
              expanded = expandedId === item.id;
            return (
              <article class={`background-process state-${item.state}`} key={item.id}>
                <div class="background-process-head">
                  <i />
                  <button class="background-process-summary" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : item.id)}>
                    <span><b>{item.label}</b><small>{task?.title || workspaceName}</small></span>
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
          {attachments.length > 0 && <>
            <div class="background-section-label environment-sources-label"><span>{zh ? '来源' : 'Sources'}</span><small>{attachments.length}</small></div>
            <div class="environment-sources">
              {attachments.map((attachment) => <button class="environment-source" key={attachment.id} onClick={() => openAttachment(attachment)}>
                <AttachmentThumbnail item={attachment} className="environment-source-thumb" />
                <span class="environment-source-copy"><b>{attachment.name}</b><small>{attachmentLabel(attachment)} · {formatAttachmentSize(attachment.size)}</small></span>
              </button>)}
            </div>
          </>}
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
  language,
}: {
  value: RunProgress;
  language: UiLanguage;
}) {
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
function attachmentLabel(item: AttachmentRef) {
  if (item.kind === 'pdf') return 'PDF';
  if (item.kind === 'document') return 'Word';
  if (item.kind === 'spreadsheet') return item.name.toLowerCase().endsWith('.csv') ? 'CSV' : 'Spreadsheet';
  if (item.kind === 'presentation') return 'Presentation';
  if (item.kind === 'image') return item.mimeType.split('/')[1]?.toUpperCase() || 'Image';
  if (item.kind === 'text') return item.name.split('.').pop()?.toUpperCase() || 'Text';
  if (item.kind === 'archive') return 'Archive';
  return 'File';
}
function attachmentCanPreview(item: AttachmentRef) {
  return item.kind === 'image' || item.kind === 'text';
}
function formatAttachmentSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}
function AttachmentTypeIcon({ item }: { item?: AttachmentRef }) {
  if (!item) return <Files />;
  if (item.kind === 'image') return <FileImage />;
  if (item.kind === 'pdf') return <span class="attachment-pdf-icon"><FileText /><b>PDF</b></span>;
  if (item.kind === 'spreadsheet') return <FileSpreadsheet />;
  if (item.kind === 'presentation') return <Presentation />;
  if (item.kind === 'archive') return <FileArchive />;
  return <FileText />;
}
type ImageDimensions = { width: number; height: number };

function AttachmentThumbnail({ item, className = "", onImageDimensions }: { item: AttachmentRef; className?: string; onImageDimensions?: (value?: ImageDimensions) => void }) {
  const [thumbnail, setThumbnail] = useState<string>('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setThumbnail('');
    setFailed(false);
    onImageDimensions?.();
    if (item.kind !== 'image') return;
    let live = true;
    window.shun.previewAttachment(item.taskId, item.id, 1, 'model').then(preview => {
      if (live && preview.mode === 'image') {
        setThumbnail(`data:${preview.mimeType};base64,${preview.data}`);
        if (preview.width && preview.height) onImageDimensions?.({ width: preview.width, height: preview.height });
      }
    }).catch(() => {});
    return () => { live = false; };
  }, [item.id, item.sha256, onImageDimensions]);
  const image = item.kind === 'image';
  return <span class={`attachment-thumb ${thumbnail && !failed ? 'has-image' : item.kind} ${className}`.trim()}>
    {thumbnail && !failed ? <img src={thumbnail} alt={image ? item.name : ""} onError={() => setFailed(true)} /> : <AttachmentTypeIcon item={item} />}
  </span>;
}
function adaptiveImageCardStyle(dimensions?: ImageDimensions) {
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return undefined;
  const ratio = dimensions.width / dimensions.height,
    width = Math.min(460, 320 * ratio);
  return { width: `min(${Math.max(1, Math.round(width))}px, 100%)`, height: 'auto', aspectRatio: `${dimensions.width} / ${dimensions.height}` };
}
function AttachmentCard({ item, remove, open, compact, adaptiveImage = false }: { item: AttachmentRef; remove?: (item: AttachmentRef) => void; open: (item: AttachmentRef) => void; compact: boolean; adaptiveImage?: boolean }) {
  const image = item.kind === 'image', previewable = attachmentCanPreview(item),
    [dimensions, setDimensions] = useState<ImageDimensions | undefined>();
  return <div class={`attachment-card ${compact ? 'compact' : ''} ${image ? 'image-card' : ''} ${adaptiveImage ? 'adaptive-image-card' : ''}`} style={image && adaptiveImage ? adaptiveImageCardStyle(dimensions) : undefined} onContextMenu={image ? (event) => { event.preventDefault(); window.shun.showAttachmentImageMenu(item.taskId, item.id); } : undefined}>
    {previewable ? <button type="button" class="attachment-open" title={item.name} onClick={() => open(item)}>
      <AttachmentThumbnail item={item} onImageDimensions={image && adaptiveImage ? setDimensions : undefined} />
      {!image && <span class="attachment-copy"><b>{item.name}</b><small>{attachmentLabel(item)} · {formatAttachmentSize(item.size)}</small></span>}
    </button> : <div class="attachment-open attachment-static" title={item.name}>
      <AttachmentThumbnail item={item} />
      <span class="attachment-copy"><b>{item.name}</b><small>{attachmentLabel(item)} · {formatAttachmentSize(item.size)}</small></span>
    </div>}
    {remove && <button type="button" class="attachment-remove" aria-label={`Remove ${item.name}`} onClick={() => remove(item)}><X /></button>}
  </div>;
}
function AttachmentCards({ items, remove, open, compact, adaptiveImages = false }: { items: AttachmentRef[]; remove?: (item: AttachmentRef) => void; open: (item: AttachmentRef) => void; compact: boolean; adaptiveImages?: boolean }) {
  return <div class={`attachment-cards ${compact ? 'compact' : ''}`}>{items.map(item => <AttachmentCard key={item.id} item={item} remove={remove} open={open} compact={compact} adaptiveImage={adaptiveImages} />)}</div>;
}

function ToolMedia({ tools, open }: { tools: ToolEvent[]; open: (item: AttachmentRef) => void }) {
  const seen = new Set<string>(), items = tools.flatMap(tool => tool.attachments || []).filter(item => !seen.has(item.id) && seen.add(item.id));
  return items.length ? <div class="tool-media"><AttachmentCards items={items} open={open} compact={false} adaptiveImages /></div> : null;
}

function TaskHistory({
  turns,
  attachments,
  running,
  language,
  retry,
  revise,
  copyText,
  openAttachment,
}: {
  turns: Turn[];
  attachments: AttachmentRef[];
  running: string;
  language: UiLanguage;
  retry: (id: string) => void;
  revise: (id: string, value: string) => void | Promise<void>;
  copyText: (value: string) => Promise<void>;
  openAttachment: (item: AttachmentRef, page?: number) => Promise<void>;
}) {
  const zh = language === "zh",
    attachmentNames = new Map([...attachments, ...turns.flatMap((turn) => [...(turn.attachments || []), ...turnTools(turn).flatMap(tool => tool.attachments || [])])].map((item) => [item.id, item.name])),
    [limit, setLimit] = useState(24),
    [editing, setEditing] = useState<{ id: string; value: string } | null>(null),
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
        return (
          <article
            class={`${turn.role} ${turn.id === running ? "running-turn" : ""}`}
            data-turn-id={turn.id}
            key={turn.id}
          >
            <div class={`body${editing?.id === turn.id ? " editing" : ""}`}>
              {editing?.id === turn.id ? (
                <form
                  class="turn-editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const next = editing.value;
                    setEditing(null);
                    void revise(turn.id, next);
                  }}
                >
                  <textarea
                    autoFocus
                    rows={Math.min(10, Math.max(2, editing.value.split("\n").length))}
                    value={editing.value}
                    onInput={(event) => setEditing({ id: turn.id, value: event.currentTarget.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEditing(null);
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <div>
                    <button type="button" onClick={() => setEditing(null)}>{zh ? "取消" : "Cancel"}</button>
                    <button class="primary" type="submit" disabled={!editing.value.trim() && !turn.attachments?.length}>{zh ? "保存并继续" : "Save and continue"}</button>
                  </div>
                </form>
              ) : (
                <TurnContent turn={turn} running={running} language={language} attachmentNames={attachmentNames} openAttachment={openAttachment} />
              )}
              <ThinkingIndicator turn={turn} running={running} language={language} />
              <TurnRuntime turn={turn} running={running} language={language} />
              {editing?.id !== turn.id && turn.content && turn.id !== running && (turn.role === "user" || turn.completedAt) && (
                <div class="turn-actions">
                  <button
                    title={zh ? "复制" : "Copy"}
                    onClick={() => void copyText(turn.content)}
                  >
                    <Copy />
                    <span>{zh ? "复制" : "Copy"}</span>
                  </button>
                  {turn.role === "user" && (
                    <button
                      title={zh ? "编辑并从这里继续" : "Edit and continue from here"}
                      onClick={() => setEditing({ id: turn.id, value: turn.content })}
                    >
                      <FilePenLine />
                      <span>{zh ? "编辑" : "Edit"}</span>
                    </button>
                  )}
                  {turn.role === "assistant" && turn.error && (
                    <button onClick={() => retry(turn.id)}>
                      <RotateCcw />
                      {zh ? "重试" : "Retry"}
                    </button>
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
function TurnRuntime({
  turn,
  running,
  language,
}: {
  turn: Turn;
  running: string;
  language: UiLanguage;
}) {
  if (turn.role !== "assistant" || turn.error || !turn.startedAt) return null;
  if (turn.id === running) return null;
  if (!turn.completedAt) return null;
  return (
    <div class="turn-runtime completed">
      <span>
        {language === "zh" ? "耗时" : "Worked for"}{" "}
        <time>{formatElapsed(turn.completedAt - turn.startedAt)}</time>
      </span>
    </div>
  );
}
const ThinkingElapsed = memo(function ThinkingElapsed() {
  const elapsedRef = useRef<HTMLTimeElement>(null),
    startedAt = useRef(Date.now());
  useEffect(() => {
    let timer = 0;
    const update = () => {
      const now = Date.now(),
        elapsed = now - startedAt.current;
      if (elapsedRef.current) {
        elapsedRef.current.hidden = elapsed < 1000;
        elapsedRef.current.textContent = elapsed < 1000 ? "" : formatElapsed(elapsed);
      }
      timer = window.setTimeout(update, 1000 - (now % 1000));
    };
    update();
    return () => window.clearTimeout(timer);
  }, []);
  return <time ref={elapsedRef} class="thinking-elapsed" hidden />;
});
function ThinkingIndicator({
  turn,
  running,
  language,
}: {
  turn: Turn;
  running: string;
  language: UiLanguage;
}) {
  const runningTurn = turn.id === running && Boolean(turn.phase),
    runningTool = turnTools(turn).some((tool) => tool.state === "running"),
    awaitingOutput = turnAwaitsModelOutput(turn),
    [quietAfterText, setQuietAfterText] = useState(false);
  useEffect(() => {
    setQuietAfterText(false);
    if (!runningTurn || runningTool || awaitingOutput) return;
    const timer = window.setTimeout(() => setQuietAfterText(true), 300);
    return () => window.clearTimeout(timer);
  }, [awaitingOutput, runningTool, runningTurn, turn.content]);
  const active = runningTurn && !runningTool && (awaitingOutput || quietAfterText);
  if (!active) return null;
  return (
    <div class="thinking">
      <ThinkingLabel label={thinkingLabel(turn.phase || "", language)} />
      <ThinkingElapsed key={turn.phase} />
    </div>
  );
}
const ThinkingLabel = memo(function ThinkingLabel({ label }: { label: string }) {
  return (
    <b class="thinking-label text-swipe">
      <SwipeLayers text={label} />
    </b>
  );
});
const fullscreenIcon =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3H3v4M13 3h4v4M17 13v4h-4M7 17H3v-4"/></svg>';
function SwipeLayers({ text }: { text: string }) {
  return <span class="swipe-layers">{text}</span>;
}

function settledToolForDisplay(tool: ToolEvent, live: boolean): ToolEvent {
  return live || tool.state !== "running"
    ? tool
    : { ...tool, state: "done" };
}

function TurnContent({
  turn,
  running,
  language,
  attachmentNames,
  openAttachment,
}: {
  turn: Turn;
  running: string;
  language: UiLanguage;
  attachmentNames: ReadonlyMap<string, string>;
  openAttachment: (item: AttachmentRef, page?: number) => Promise<void>;
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
              tools={entry.tools}
              kind={entry.kind}
              language={language}
              attachmentNames={attachmentNames}
              openAttachment={openAttachment}
              live={activityLive}
            />
          ) : entry.type === "text" ? (
            <Message
              key={`${hidden + i}-text`}
              text={entry.text}
              streaming={turn.id === running}
            />
          ) : entry.type === "tool" ? (
            <div class="tool-with-media" key={entry.tool.id}>
              <Tool
                tool={settledToolForDisplay(entry.tool, activityLive)}
                attachmentNames={attachmentNames}
              />
              <ToolMedia tools={[entry.tool]} open={(item) => void openAttachment(item)} />
            </div>
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
      {!!turn.attachments?.length && <AttachmentCards items={turn.attachments} open={(item) => void openAttachment(item)} compact />}
      {!!tools.length && (
        <ToolGroup
          tools={tools}
          attachmentNames={attachmentNames}
          openAttachment={openAttachment}
          live={turn.id === running && !turn.content.trim()}
        />
      )}{" "}
      {turn.content && (turn.role === "user" && turn.attachments?.length ? <div class="attachment-message-text"><Message text={turn.content} streaming={turn.id === running} /></div> : <Message text={turn.content} streaming={turn.id === running} />)}
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
function isRecoveredBrowserConnectionFailure(tool: ToolEvent, tools: ToolEvent[]) {
  if (
    tool.state !== "error" ||
    productToolPresentation(tool)?.kind !== "browser" ||
    !/(?:not connected|connection (?:changed|closed)|unknown or released Browser Use session)/i.test(tool.output || "")
  ) return false;
  const index = tools.indexOf(tool);
  return tools.slice(index + 1).some(
    (later) => later.state === "done" && productToolPresentation(later)?.kind === "browser",
  );
}
function attachmentToolName(tool: ToolEvent, id: string, names?: ReadonlyMap<string, string>) {
  if (!names) return id
  const known = names.get(id)
  if (known) return known
  try {
    const output = JSON.parse(tool.output || '{}'), name = output?.attachment?.name || output?.details?.attachment?.name
    if (typeof name === 'string' && name.trim()) return name.trim()
  } catch {}
  return 'attachment'
}
function toolTarget(tool: ToolEvent, attachmentNames?: ReadonlyMap<string, string>) {
  const product = productToolPresentation(tool);
  if (product) return product.detail;
  try {
    const input = JSON.parse(tool.input || "{}");
    return String(
      tool.name === "web_search" || tool.name === "search"
        ? input.query
        : tool.name === "web_read"
          ? input.url
          : tool.name === "attachment_list"
            ? "uploaded files"
            : tool.name === "attachment_read" || tool.name === "attachment_view"
              ? attachmentToolName(tool, input.attachment_id || "attachment", attachmentNames)
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
  attachmentNames?: ReadonlyMap<string, string>,
) {
  const zh = language === "zh",
    running = tools.some((tool) => tool.state === "running"),
    recovered = recoveredEditGroup(tools),
    browserOnly = tools.length > 0 && tools.every((tool) => productToolPresentation(tool)?.kind === "browser"),
    pluginDiscoveryOnly = tools.length > 0 && tools.every((tool) => tool.name === "plugin_tool_search"),
    cloudflareOnly = tools.length > 0 && tools.every((tool) => productToolPresentation(tool)?.kind === "cloudflare"),
    failures = tools.filter(
      (tool) =>
        tool.state === "error" &&
        !(recovered && isRefreshableEditFailure(tool)),
    ).length,
    allFailed = summarizedFailureCount(failures, tools.length) > 0;
  const targets = [
    ...new Set(
      tools.map((tool) => shortTarget(toolTarget(tool, attachmentNames))).filter(Boolean),
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
          ? targets.length === 1
            ? `正在修改 ${targets[0]}`
            : targets.length > 1
              ? `正在修改 ${targets.length} 个文件`
              : "正在修改"
          : recovered
            ? `已刷新 ${targets[0] || "修改原文"}`
            : allFailed
              ? "修改未成功"
              : targets.length === 1
                ? `已修改 ${targets[0]}`
                : `已修改 ${targets.length} 个文件`
        : running
          ? targets.length === 1
            ? `Changing ${targets[0]}`
            : targets.length > 1
              ? `Changing ${targets.length} files`
              : "Applying changes"
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
      const opened = new Set(tools.filter((tool) => tool.name === "web_read" && tool.state === "done").map(tool => toolTarget(tool)));
      const reading = tools.some((tool) => tool.name === "web_read" && tool.state === "running"),
        includesRead = tools.some((tool) => tool.name === "web_read");
      return {
        title: zh
          ? running
            ? reading ? "正在读取网页" : "正在搜索网页"
            : allFailed
              ? includesRead ? "网页读取未成功" : "网页搜索未成功"
            : opened.size
              ? `已读取 ${opened.size} 个网页`
              : "已搜索网页"
          : running
            ? reading ? "Reading web page" : "Searching web"
            : allFailed
              ? includesRead ? "Web page read failed" : "Web search failed"
            : opened.size
              ? `Read ${opened.size} web ${opened.size === 1 ? "page" : "pages"}`
              : "Searched web",
        detail,
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
      if (pluginDiscoveryOnly) return {
        title: zh
          ? running ? "正在准备插件工具" : allFailed ? "插件工具准备失败" : "已准备插件工具"
          : running ? "Preparing plugin tools" : allFailed ? "Plugin tool preparation failed" : "Prepared plugin tools",
        detail: failureText,
      };
      if (cloudflareOnly) return {
        title: zh
          ? running ? "正在查询 Cloudflare" : allFailed ? "Cloudflare 查询失败" : "已查询 Cloudflare"
          : running ? "Querying Cloudflare" : allFailed ? "Cloudflare query failed" : "Queried Cloudflare",
        detail: [targetList ? `${targetList}${extra}` : "", failureText].filter(Boolean).join(" · "),
      };
      if (browserOnly) return {
        title: zh
          ? running
            ? "正在查看 Chrome 页面"
            : allFailed
              ? "Chrome 页面操作未成功"
              : "已查看 Chrome 页面"
          : running
            ? "Inspecting Chrome page"
            : allFailed
              ? "Chrome page action failed"
              : "Inspected Chrome page",
        detail: [targetList ? `${targetList}${extra}` : "", failureText].filter(Boolean).join(" · "),
      };
      const reads = tools.filter((tool) => tool.name === "read" || tool.name === "read_pdf" || tool.name === "attachment_read" || tool.name === "attachment_view" || tool.name === "attachment_list").length,
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
                : targets.length === 1
                  ? `已读取 ${targets[0]} ${reads} 次`
                  : `已读取 ${targets.length} 个文件（${reads} 次）`
              : `已完成 ${tools.length} 项读取/搜索`
          : running
            ? "Reading or searching code"
            : allFailed
              ? "Read or search failed"
            : reads && !searches
              ? reads === 1 && targets[0]
                ? `Read ${targets[0]}`
                : targets.length === 1
                  ? `Read ${targets[0]} ${reads} times`
                  : `Read ${targets.length} files (${reads} reads)`
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
  language,
  attachmentNames,
  openAttachment,
  kind,
  live,
}: {
  tools: ToolEvent[];
  language: UiLanguage;
  attachmentNames: ReadonlyMap<string, string>;
  openAttachment: (item: AttachmentRef, page?: number) => Promise<void>;
  kind: "research" | "inspection" | "command" | "change" | "verification";
  live: boolean;
}) {
  const settledTools = sourceTools.map((tool) => settledToolForDisplay(tool, live)),
    tools = settledTools.filter((tool) => !isRecoveredBrowserConnectionFailure(tool, settledTools));
  const [open, setOpen] = useState(false),
    running = tools.some((tool) => tool.state === "running"),
    executing = tools.some((tool) => tool.state === "running"),
    recovered = recoveredEditGroup(tools),
    failures = tools.filter(
      (tool) =>
        tool.state === "error" &&
        !(recovered && isRefreshableEditFailure(tool)),
    ).length,
    allFailed = failures > 0 && failures === tools.length,
    copy = actionGroupCopy(tools, kind, language, attachmentNames),
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
      <button class="activity-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon />
        <span>
          <b>{executing ? <SwipeLayers text={copy.title} /> : copy.title}</b>
          {copy.detail && <small>{copy.detail}</small>}
        </span>
        {open ? <ChevronUp /> : <ChevronDown />}
      </button>
      <ToolMedia tools={tools} open={(item) => void openAttachment(item)} />
      {open && (
        <div class="activity-list">
          {tools.map((tool) => (
            <Tool
              key={tool.id}
              tool={tool}
              attachmentNames={attachmentNames}
              recovered={recovered && isRefreshableEditFailure(tool)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
function stableMarkdownBoundary(text: string) {
  let fence = "",
    boundary = 0,
    offset = 0;
  for (const line of text.match(/.*(?:\r?\n|$)/g) || []) {
    if (!line) continue;
    const body = line.replace(/\r?\n$/, ""),
      marker = body.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1] || "";
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = "";
        boundary = offset + line.length;
      }
    }
    offset += line.length;
    if (!fence && !body.trim()) boundary = offset;
  }
  return boundary;
}
function renderMarkdownFragment(text: string) {
  return DOMPurify.sanitize(
    markdown.parse(normalizeMarkdown(text), {
      breaks: true,
      async: false,
    }) as string,
  );
}
const Message = memo(function Message({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const node = useRef<HTMLDivElement>(null);
  const streamTarget = useRef(text);
  const streamFrame = useRef(0);
  const [renderedText, setRenderedText] = useState(() => streaming ? "" : text);
  const streamMarkup = useRef({ source: "", committed: 0, fragments: [] as string[] });
  const mermaidUi = useRef(
    new Map<number, { visual: boolean; scrollTop: number; scrollLeft: number }>(),
  );
  streamTarget.current = text;
  useEffect(() => {
    if (!streaming) {
      if (!streamFrame.current && renderedText === text) return;
    } else if (renderedText === text) return;

    const step = () => {
      streamFrame.current = 0;
      setRenderedText((current) => {
        const target = streamTarget.current;
        const next = nextStreamingText(current, target);
        if (next !== target && !streamFrame.current)
          streamFrame.current = requestAnimationFrame(step);
        return next;
      });
    };
    if (!streamFrame.current) streamFrame.current = requestAnimationFrame(step);
  }, [text, streaming, renderedText]);
  useEffect(() => () => {
    if (streamFrame.current) cancelAnimationFrame(streamFrame.current);
  }, []);
  const rendered = useMemo(() => {
    if (!streaming) return {
      fragments: [renderMarkdownFragment(renderedText)],
      tail: "",
      decoratedSource: renderedText,
    };
    const cache = streamMarkup.current;
    if (!renderedText.startsWith(cache.source)) {
      cache.source = "";
      cache.committed = 0;
      cache.fragments = [];
    }
    cache.source = renderedText;
    const boundary = stableMarkdownBoundary(renderedText);
    if (boundary > cache.committed) {
      cache.fragments = [
        ...cache.fragments,
        renderMarkdownFragment(renderedText.slice(cache.committed, boundary)),
      ];
      cache.committed = boundary;
    }
    return {
      fragments: cache.fragments,
      tail: renderedText.slice(cache.committed),
      decoratedSource: renderedText.slice(0, cache.committed),
    };
  }, [renderedText, streaming]);
  useLayoutEffect(() => {
    let live = true;
    const cleanups: (() => void)[] = [];
    const mathNodes = [...(node.current?.querySelectorAll<HTMLElement>(".math-source[data-katex]") || [])];
    if (mathNodes.length) void import("katex")
      .then(({ default: katex }) => {
        if (!live) return;
        for (const element of mathNodes) {
          const source = decodeURIComponent(element.dataset.katex || "");
          katex.render(source, element, {
            displayMode: element.dataset.display === "true",
            throwOnError: false,
            strict: "ignore",
          });
        }
      })
      .catch(() => {});
    const completedMermaidBlocks = completedMermaidBlockCount(rendered.decoratedSource);
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
        modalHead.append(actions);
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
  }, [rendered.decoratedSource, streaming]);
  return (
    <div ref={node} class="copy">
      {rendered.fragments.map((html, index) => (
        <div class="stream-markdown-fragment" key={index} dangerouslySetInnerHTML={{ __html: html }} />
      ))}
      {rendered.tail && <span class="stream-markdown-tail">{rendered.tail}</span>}
    </div>
  );
});

async function renderMermaid(source: string) {
  const light = document.documentElement.dataset.theme === "light",
    accent = accentColor(document.documentElement.dataset.accent);
  const normalized = normalizeMermaid(source);
  const palette = {
    bg: light ? "#ffffff" : "#111111",
    fg: light ? "#1e1e1e" : "#ececec",
    line: light ? "#1e1e1e" : "#ececec",
    accent,
    muted: light ? "#8d8d8d" : "#9f9f9f",
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
function ToolGroup({ tools: sourceTools, attachmentNames, openAttachment, live }: { tools: ToolEvent[]; attachmentNames: ReadonlyMap<string, string>; openAttachment: (item: AttachmentRef, page?: number) => Promise<void>; live: boolean }) {
  const tools = sourceTools.map((tool) => settledToolForDisplay(tool, live));
  const active = tools.some((x) => x.state === "running"),
    executing = tools.some((x) => x.state === "running"),
    kinds = [
      ...new Set(
        tools.map((x) => {
          const product = productToolPresentation(x);
          return product?.kind === "github"
            ? "used GitHub"
            : product?.kind === "figma"
              ? "read Figma"
            : product?.kind === "render"
              ? "used Render"
            : product?.kind === "cloudflare"
              ? "used Cloudflare"
            : product?.kind === "browser"
              ? "used Chrome"
            : product?.kind === "skill"
              ? "managed Skills"
            : isShellTool(x)
            ? "ran commands"
            : x.name === "web_search"
              ? "searched web"
            : x.name === "web_read"
                ? "read web"
                : x.name === "mcp_list" || x.name === "mcp_call"
                  ? "used MCP"
                : x.name === "read" || x.name === "read_pdf" || x.name === "attachment_list" || x.name === "attachment_read" || x.name === "attachment_view" || x.name === "list" || x.name === "search"
                  ? "read files"
                  : "edited files";
        }),
      ),
    ],
    [open, setOpen] = useState(active);
  useEffect(() => setOpen(active), [active]);
  return (
    <section class={`activity ${active ? "active" : ""} ${executing ? "executing" : ""}`}>
      <button class="activity-head" onClick={() => setOpen(!open)}>
        <FilePenLine />
        <span>
          <b>{executing ? <SwipeLayers text="Working" /> : sentence(kinds.join(", "))}</b>
        </span>
        {open ? <ChevronUp /> : <ChevronDown />}
      </button>
      <ToolMedia tools={tools} open={(item) => void openAttachment(item)} />
      {open && (
        <div class="activity-list">
          {tools.map((tool) => (
            <Tool key={tool.id} tool={tool} attachmentNames={attachmentNames} />
          ))}
        </div>
      )}
    </section>
  );
}
function Tool({
  tool,
  attachmentNames,
  recovered = false,
}: {
  tool: ToolEvent;
  attachmentNames: ReadonlyMap<string, string>;
  recovered?: boolean;
}) {
  const [open, setOpen] = useState(false),
    rawDetail = toolDetail(tool, attachmentNames),
    detail = recovered
      ? { title: "Source changed", detail: rawDetail.detail }
      : rawDetail,
    change = toolDiff(tool),
    presentation = productToolPresentation(tool),
    Icon =
      presentation?.kind === "github"
        ? GitBranch
        : presentation?.kind === "figma"
          ? Palette
        : presentation?.kind === "render"
          ? Server
        : presentation?.kind === "cloudflare"
          ? Cloud
        : presentation?.kind === "browser"
          ? Monitor
        : presentation?.kind === "skill"
          ? Puzzle
      : isShellTool(tool)
        ? SquareTerminal
        : tool.name === "read_pdf"
          ? FileText
        : tool.name === "attachment_view"
          ? FileImage
        : tool.name === "attachment_list" || tool.name === "attachment_read"
          ? Paperclip
        : tool.name === "web_search"
          ? Search
          : tool.name === "mcp_list" || tool.name === "mcp_call"
            ? Cable
          : tool.name === "write" || tool.name === "edit" || tool.name === "edit_lines" || tool.name === "replace_all"
            ? FilePenLine
            : Files;
  return (
    <div class={`tool-row ${recovered ? "state-done" : `state-${tool.state}`}`}>
      <button class="tool-row-head" onClick={() => setOpen(!open)}>
        <Icon />
        <span>
          <b>{tool.state === "running" ? <SwipeLayers text={detail.title} /> : detail.title}</b>
          <small>{detail.detail}</small>
        </span>
        <em>
          {recovered
            ? "Refreshed"
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
                : productToolOutputForDisplay(tool) || "No output"}
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
                  : "✓ Success"}
          </div>
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
function toolDetail(tool: ToolEvent, attachmentNames?: ReadonlyMap<string, string>) {
  const product = productToolPresentation(tool);
  if (product) return { title: product.title, detail: product.detail };
  let input: any = {};
  try {
    input = JSON.parse(tool.input);
  } catch {}
  const value = String(
    tool.name === "search" || tool.name === "web_search"
      ? input.query
      : tool.name === "web_read"
        ? input.url
        : tool.name === "attachment_list"
          ? "uploaded files"
          : tool.name === "attachment_read" || tool.name === "attachment_view"
            ? attachmentToolName(tool, input.attachment_id || "attachment", attachmentNames)
        : tool.name === "mcp_list"
          ? input.server || "configured MCP servers"
          : tool.name === "mcp_call"
            ? `${input.server || "MCP"}/${input.name || "tool"}`
        : tool.name === "plugin_tool_search"
          ? ""
        : isShellTool(tool)
          ? shellCommand(tool)
          : input.path || ".",
  );
  return tool.name === "write"
    ? {
        title:
      tool.state === "error"
            ? "Write failed"
            : tool.state === "running"
              ? "Writing"
              : "Wrote",
        detail: value,
      }
    : tool.name === "edit" || tool.name === "edit_lines" || tool.name === "replace_all"
      ? {
          title:
            tool.state === "error"
              ? "Edit failed"
              : tool.state === "running"
                ? "Editing"
                : "Edited",
          detail: value,
        }
      : tool.name === "read"
        ? { title: "Read", detail: value }
        : tool.name === "read_pdf"
          ? { title: "Read PDF", detail: value }
        : tool.name === "attachment_list"
          ? { title: "Listed attachments", detail: value }
        : tool.name === "attachment_read"
          ? { title: "Read attachment", detail: value }
        : tool.name === "attachment_view"
          ? { title: "Viewed attachment", detail: value }
        : tool.name === "search"
          ? { title: "Searched", detail: value }
          : tool.name === "web_search"
            ? { title: "Searched web", detail: value }
            : tool.name === "web_read"
              ? { title: "Read web", detail: value }
              : tool.name === "mcp_list"
                ? { title: "Discovered MCP", detail: value }
              : tool.name === "mcp_call"
                  ? { title: tool.state === "error" ? "MCP call failed" : "Called MCP", detail: value }
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
                    <b>{models.length} models</b>
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
                <div class="toggle-row">
                  <span>
                    <b>Automatic context management</b>
                    <small>
                      Summarize older turns and tool results before context
                      overflow.
                    </small>
                  </span>
                  <span class="always-on"><Check />Always on</span>
                </div>
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
                  <p>Direct local tool execution.</p>
                </div>
              </div>
              <div class="context-note">
                <SquareTerminal />
                <div>
                  <b>Tools run automatically</b>
                  <p>Shun does not add per-command permission popups. A workspace sets the working directory but is not a filesystem boundary; standalone tasks use a private internal working directory. Absolute paths use your account permissions. Project-local configuration and extensions use a separate startup trust decision. Use an OS sandbox, container, or VM when stronger isolation is required.</p>
                </div>
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
                    Move messages and tool history. Uploaded file binaries stay on this device.
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
  notify,
}: {
  value: Settings;
  models: string[];
  update: (fn: (x: Settings) => Settings) => void;
  close: () => void;
  exportTask: () => void;
  importTask: () => void;
  notify: (input: ToastInput) => void;
}) {
  const mainstreamProviderIds = ["openai", "anthropic", "google", "deepseek", "xai", "zai", "moonshotai", "openrouter"];
  const [tab, setTab] = useState<"providers" | "model" | "appearance" | "agent">("providers"),
    [addingProvider, setAddingProvider] = useState(false),
    [catalog, setCatalog] = useState<ProviderCatalog | null>(null),
    [catalogLoading, setCatalogLoading] = useState(false),
    [setupCatalogId, setSetupCatalogId] = useState(""),
    [setupVariantId, setSetupVariantId] = useState(""),
    [setupSubmitting, setSetupSubmitting] = useState(false),
    [showAdvancedCloud, setShowAdvancedCloud] = useState(false),
    [showLocalEndpoint, setShowLocalEndpoint] = useState(false),
    [localDiscoveryFailed, setLocalDiscoveryFailed] = useState(false),
    [setupCustomApi, setSetupCustomApi] = useState<ProviderApi>("openai-completions"),
    [setupEndpoint, setSetupEndpoint] = useState(""),
    [setupApiKey, setSetupApiKey] = useState(""),
    [setupModel, setSetupModel] = useState(""),
    [addingDeployment, setAddingDeployment] = useState(false),
    [deploymentQuery, setDeploymentQuery] = useState(""),
    [deploymentTests, setDeploymentTests] = useState<Record<string, DeploymentTestState>>({}),
    active = value.providers.find((item) => item.id === value.providerId) || value.providers[0],
    activeModels = active ? normalizeProviderModels(active, value.contextWindow) : [],
    selectedModel = activeModels.find((item) => item.id === value.model) || activeModels[0],
    contextWindow = Math.max(1, selectedModel?.contextWindow || value.contextWindow),
    maxOutputTokens = Math.min(contextWindow, Math.max(0, selectedModel?.maxOutputTokens || value.maxTokens)),
    conversationBudget = Math.max(0, contextWindow - maxOutputTokens),
    outputShare = Math.min(100, Math.max(0, (maxOutputTokens / contextWindow) * 100)),
    zh = resolveUiLanguage(value.language) === "zh",
    t = (en: string, cn: string) => zh ? cn : en,
    field = (key: keyof Settings, next: any) => update((current) => ({ ...current, [key]: next }));

  useEffect(() => {
    if (tab !== "providers" || catalog || catalogLoading) return;
    setCatalogLoading(true);
    window.shun.providerCatalog()
      .then(async (next) => {
        setCatalog(next);
        if (next.source === "fallback") setCatalog(await window.shun.providerCatalog());
      })
      .catch(() => setCatalog(null))
      .finally(() => setCatalogLoading(false));
  }, [tab]);

  const setupCatalogProvider = catalog?.providers.find((provider) => provider.id === setupCatalogId),
    setupLocalProvider = setupCatalogId.startsWith("local:") ? localProviderPresets.find((provider) => provider.id === setupCatalogId.slice(6)) : undefined,
    setupCatalogVariant = setupCatalogProvider?.variants?.find((variant) => variant.id === setupVariantId),
    setupRequiresEndpoint = Boolean(setupCatalogVariant?.requiresEndpoint || setupCatalogProvider?.requiresEndpoint),
    simpleCloudProviders = mainstreamProviderIds.map((id) => catalog?.providers.find((provider) => provider.id === id)).filter((provider): provider is ProviderCatalogEntry => Boolean(provider)).slice(0, 8),
    advancedCloudProviders = catalog?.providers.filter((provider) => !simpleCloudProviders.some((item) => item.id === provider.id)) || [],
    activeCatalogProvider = active && catalog?.providers.find((provider) =>
      provider.id === active.catalogId ||
      provider.variants?.some((variant) => variant.id === active.catalogId) ||
      provider.endpoint === active.endpoint ||
      provider.variants?.some((variant) => variant.endpoint === active.endpoint)),
    configuredModelIds = new Set(activeModels.map((model) => model.id)),
    availableCatalogModels = activeCatalogProvider?.models.filter((model) => !configuredModelIds.has(model.id)) || [],
    normalizedDeploymentQuery = deploymentQuery.trim().toLowerCase(),
    deploymentCandidates = normalizedDeploymentQuery
      ? availableCatalogModels.filter((model) => `${model.id} ${model.name || ""}`.toLowerCase().includes(normalizedDeploymentQuery)).slice(0, 50)
      : compactProviderModelMenu(availableCatalogModels, "", true, 8).primary;

  useEffect(() => {
    if (!catalog) return;
    update((current) => {
      let changed = false;
      const providers = current.providers.map((provider) => {
        if (provider.kind !== "cloud" || !provider.models?.length) return provider;
        const source = catalog.providers.find((candidate) =>
          candidate.id === provider.catalogId ||
          candidate.variants?.some((variant) => variant.id === provider.catalogId) ||
          candidate.endpoint === provider.endpoint ||
          candidate.variants?.some((variant) => variant.endpoint === provider.endpoint));
        if (!source) return provider;
        const metadata = new Map(source.models.map((model) => [model.id, model])),
          featured = new Set(source.featuredModels.map((model) => model.id)),
          nextModels = provider.models.map((configured) => {
            const fresh = metadata.get(configured.id);
            if (!fresh) return configured;
            const next = { ...configured, ...fresh, featured: featured.has(configured.id) || undefined, enabled: configured.enabled };
            if (JSON.stringify(next) !== JSON.stringify(configured)) changed = true;
            return next;
          });
        return changed ? { ...provider, models: nextModels } : provider;
      });
      if (!changed) return current;
      const selectedProvider = providers.find((provider) => provider.id === current.providerId) || providers[0],
        selectedModel = selectedProvider?.models?.find((model) => model.id === current.model);
      return {
        ...current,
        providers,
        contextWindow: selectedModel?.contextWindow || current.contextWindow,
        maxTokens: selectedModel?.maxOutputTokens || current.maxTokens,
      };
    });
  }, [catalog]);

  const resetProviderSetup = () => {
    setAddingProvider(false);
    setSetupCatalogId("");
    setSetupVariantId("");
    setSetupSubmitting(false);
    setShowAdvancedCloud(false);
    setShowLocalEndpoint(false);
    setLocalDiscoveryFailed(false);
    setSetupCustomApi("openai-completions");
    setSetupEndpoint("");
    setSetupApiKey("");
    setSetupModel("");
  };

  useEffect(() => {
    const closeProviderDialog = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (addingProvider) resetProviderSetup();
      else if (addingDeployment) { setAddingDeployment(false); setDeploymentQuery(""); }
      else close();
    };
    addEventListener("keydown", closeProviderDialog);
    return () => removeEventListener("keydown", closeProviderDialog);
  }, [addingProvider, addingDeployment]);

  const chooseCatalogProvider = (provider: ProviderCatalogEntry) => {
    const regionSuffix = zh ? "-cn" : "-global",
      variant = provider.variants?.find((item) => item.id === (zh && provider.id === "zai" ? "zhipu-cn" : `${provider.id}${regionSuffix}`)) || provider.variants?.[0];
    setSetupCatalogId(provider.id);
    setSetupVariantId(variant?.id || "");
    setSetupEndpoint(variant?.endpoint || provider.endpoint);
    setSetupModel(provider.featuredModels[0]?.id || "");
  };

  const chooseCatalogVariant = (variant: NonNullable<ProviderCatalogEntry["variants"]>[number]) => {
    setSetupVariantId(variant.id);
    setSetupEndpoint(variant.endpoint);
  };
  const chooseLocalProvider = (provider: typeof localProviderPresets[number]) => {
    setSetupCatalogId(`local:${provider.id}`);
    setSetupVariantId("");
    setSetupEndpoint(provider.endpoint);
    setSetupModel("");
    setShowLocalEndpoint(false);
    setLocalDiscoveryFailed(false);
  };

  const selectProvider = (provider: Provider) => {
    const list = normalizeProviderModels(provider, provider.contextWindow),
      model = list.find((item) => item.id === value.model) || list[0];
    resetProviderSetup();
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
  const editProvider = (key: "name" | "endpoint" | "apiKey", next: string) => {
    if (!active) return;
    update((current) => ({
      ...current,
      ...(key === "name" ? {} : { [key]: next }),
      providers: current.providers.map((provider) => provider.id === active.id ? { ...provider, [key]: next } : provider),
    }));
  };
  const finishProviderSetup = async () => {
    const catalogProvider = setupCatalogProvider, localProvider = setupLocalProvider,
      connection = normalizeProviderConnection({ endpoint: setupEndpoint, api: catalogProvider?.api || setupCustomApi }),
      endpoint = connection.endpoint;
    if (!endpoint || (catalogProvider && !setupApiKey.trim())) return;
    setSetupSubmitting(true);
    let discoveredModels: ProviderModel[] = [], modelId = setupModel.trim();
    if (localProvider && !modelId) {
      const ids = await window.shun.models(endpoint, setupApiKey.trim(), connection.api);
      if (!ids.length) {
        setSetupSubmitting(false);
        setLocalDiscoveryFailed(true);
        setShowLocalEndpoint(true);
        notify({ tone: "error", title: t("No models found", "未发现模型"), message: t("Check that the local server is running, or enter its address and model ID.", "请确认本地服务已启动，或填写服务地址与模型 ID。") });
        return;
      }
      discoveredModels = ids.slice(0, 4).map((id) => {
        const metadata = catalog?.providers.flatMap((provider) => provider.models).find((model) => model.id === id || model.id.endsWith(`/${id}`));
        return metadata ? { ...metadata, id, featured: undefined } : { id, contextWindow: 32768, maxOutputTokens: 8192 };
      });
      modelId = discoveredModels[0].id;
    }
    if (!modelId) { setSetupSubmitting(false); return; }
    let name = setupCatalogVariant?.name || catalogProvider?.name || localProvider?.name || t("Model provider", "模型 Provider");
    if (!catalogProvider && !localProvider) try {
      const host = new URL(endpoint).hostname;
      name = /^(?:127\.0\.0\.1|localhost)$/.test(host) ? t("Local model", "本地模型") : host;
    } catch {}
    const metadata = catalogProvider?.models.find((model) => model.id === modelId),
      selected = metadata ? { ...metadata } : { id: modelId, contextWindow: 32768, maxOutputTokens: 8192 },
      configuredModels = catalogProvider ? catalogProvider.featuredModels.map((model) => ({ ...model })) : discoveredModels.length ? discoveredModels : [selected],
      provider: Provider = {
        id: uid(), name, kind: catalogProvider ? "cloud" : localProvider?.id || "custom", catalogId: setupCatalogVariant?.id || catalogProvider?.id, api: connection.api,
        endpoint, apiKey: setupApiKey.trim(), contextWindow: selected.contextWindow, models: configuredModels,
      };
    update((current) => ({ ...current, providers: [...current.providers, provider], providerId: provider.id, endpoint, apiKey: provider.apiKey, model: modelId, contextWindow: selected.contextWindow, maxTokens: selected.maxOutputTokens }));
    notify({ tone: "success", title: t("Provider added", "Provider 已添加"), message: name });
    resetProviderSetup();
  };
  const removeProvider = () => {
    if (!active) return;
    update((current) => {
    const nextProviders = current.providers.filter((provider) => provider.id !== active.id),
      provider = nextProviders[0];
    if (!provider) return { ...current, providers: [], providerId: "", endpoint: "", apiKey: "", model: "" };
    const model = normalizeProviderModels(provider, provider.contextWindow)[0];
    return { ...current, providers: nextProviders, providerId: provider.id, endpoint: provider.endpoint, apiKey: provider.apiKey, model: model?.id || "", contextWindow: model?.contextWindow || provider.contextWindow, maxTokens: model?.maxOutputTokens || current.maxTokens };
    });
  };
  const editModel = (id: string, key: keyof ProviderModel, next: string | number) => update((current) => {
    if (!active) return current;
    let selectedId = current.model;
    const nextProviders = current.providers.map((provider) => {
      if (provider.id !== active.id) return provider;
      const list = normalizeProviderModels(provider, current.contextWindow).map((model) => {
        if (model.id !== id) return model;
        if (key === "id" && current.model === id) selectedId = String(next);
        const edited = { ...model, [key]: next } as ProviderModel;
        if (key === "contextWindow") edited.maxOutputTokens = Math.min(edited.maxOutputTokens, Number(next));
        if (key === "maxOutputTokens") edited.maxOutputTokens = Math.min(model.contextWindow, Number(next));
        return edited;
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
  const addModel = () => {
    if (active?.kind === "cloud") {
      setDeploymentQuery("");
      setAddingDeployment(true);
      return;
    }
    update((current) => {
    if (!active) return current;
    const list = normalizeProviderModels(active, current.contextWindow),
      model = { id: `model-${list.length + 1}`, contextWindow: active.contextWindow || current.contextWindow, maxOutputTokens: current.maxTokens || 8192 };
    return { ...current, model: model.id, contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens, providers: current.providers.map((provider) => provider.id === active.id ? { ...provider, models: [...list, model] } : provider) };
    });
  };
  const addCatalogDeployment = (model: ProviderModel) => {
    if (!active) return;
    update((current) => ({
      ...current,
      model: model.id,
      contextWindow: model.contextWindow,
      maxTokens: model.maxOutputTokens,
      providers: current.providers.map((provider) => provider.id === active.id
        ? { ...provider, models: [...normalizeProviderModels(provider, current.contextWindow), { ...model }] }
        : provider),
    }));
    setAddingDeployment(false);
    setDeploymentQuery("");
  };
  const removeModel = (id: string) => update((current) => {
    if (!active) return current;
    const list = normalizeProviderModels(active, current.contextWindow).filter((model) => model.id !== id),
      selected = current.model === id ? list[0] : list.find((model) => model.id === current.model);
    return { ...current, model: selected?.id || current.model, contextWindow: selected?.contextWindow || current.contextWindow, maxTokens: selected?.maxOutputTokens || current.maxTokens, providers: current.providers.map((provider) => provider.id === active.id ? { ...provider, models: list } : provider) };
  });
  const testDeployment = async (model: ProviderModel) => {
    if (!active) return;
    const key = `${active.id}:${model.id}`,
      startedAt = Date.now();
    setDeploymentTests((current) => ({ ...current, [key]: { status: "testing", message: t("Testing model…", "正在测试模型…") } }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(t("Connection test timed out after 18 seconds", "连接测试已在 18 秒后超时"))), 18_000);
      });
      const result = await Promise.race([window.shun.testModel(active.endpoint, active.apiKey, model.id, active.api), timeout]);
      setDeploymentTests((current) => ({ ...current, [key]: { status: result.ok ? "success" : "error", message: result.message, latencyMs: result.latencyMs } }));
      notify({
        tone: result.ok ? "success" : "error",
        title: result.ok ? t("Deployment is available", "部署连接正常") : t("Connection failed", "连接失败"),
        message: result.ok ? `${model.id} · ${result.latencyMs} ms` : `${model.id} · ${result.message}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("Connection test failed", "连接测试失败"),
        latencyMs = Date.now() - startedAt;
      setDeploymentTests((current) => ({ ...current, [key]: { status: "error", message, latencyMs } }));
      notify({ tone: "error", title: t("Connection failed", "连接失败"), message: `${model.id} · ${message}` });
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const providerSetup = (inline = false) => <form class={`provider-onboarding ${inline ? "provider-onboarding-inline" : ""}`} onSubmit={(event) => { event.preventDefault(); void finishProviderSetup(); }}>
    {!setupCatalogId ? <>
      <div class="provider-onboarding-mark"><Server /></div>
      <div class="provider-onboarding-copy"><h3>{inline ? t("Add provider", "添加 Provider") : t("Connect a model", "连接模型")}</h3></div>
      <small class="provider-picker-heading">{t("Cloud providers", "云端 Provider")}</small>
      <div class="provider-picker">
        {simpleCloudProviders.map((provider) => <button type="button" onClick={() => chooseCatalogProvider(provider)}><ProviderBrandMark id={provider.id} name={provider.name} /><span><b>{provider.name}</b><small>{provider.variants?.map((variant) => variant.label).join(" · ") || "API key"}</small></span><ChevronDown /></button>)}
      </div>
      {advancedCloudProviders.length > 0 && <><button type="button" class={`advanced-cloud-toggle ${showAdvancedCloud ? "open" : ""}`} onClick={() => setShowAdvancedCloud((current) => !current)}>{t("More providers", "更多 Provider")}<ChevronDown /></button>{showAdvancedCloud && <div class="provider-picker advanced-cloud-providers">{advancedCloudProviders.map((provider) => <button type="button" onClick={() => chooseCatalogProvider(provider)}><ProviderBrandMark id={provider.id} name={provider.name} /><span><b>{provider.name}</b><small>{provider.variants?.map((variant) => variant.label).join(" · ") || (provider.requiresEndpoint ? t("Endpoint · credentials", "端点 · 凭证") : "API key")}</small></span><ChevronDown /></button>)}</div>}</>}
      <small class="provider-picker-heading local-heading">{t("Local & custom", "本地与自定义")}</small>
      <div class="provider-picker">{localProviderPresets.map((provider) => <button type="button" onClick={() => chooseLocalProvider(provider)}><ProviderBrandMark id={provider.id} name={provider.name} preserveColor={provider.id === "lmstudio"} /><span><b>{provider.name}</b><small>{t("Auto-discover models", "自动发现模型")}</small></span><ChevronDown /></button>)}<button type="button" onClick={() => { setSetupCatalogId("custom"); setSetupVariantId(""); setSetupEndpoint("http://127.0.0.1:8000/v1"); setSetupCustomApi("openai-completions"); }}><span class="provider-letter"><SlidersHorizontal /></span><span><b>{t("Custom endpoint", "自定义端点")}</b><small>Messages · Chat · Responses</small></span><ChevronDown /></button></div>
      {catalogLoading && <p class="catalog-state"><LoaderCircle class="loading-spinner" />{t("Updating model catalog…", "正在更新模型目录…")}</p>}
      {inline && <div class="provider-setup-actions"><button type="button" class="setup-cancel" onClick={resetProviderSetup}>{t("Cancel", "取消")}</button></div>}
    </> : <>
      <button type="button" class="setup-back" onClick={() => { setSetupCatalogId(""); setSetupVariantId(""); setSetupModel(""); setSetupApiKey(""); setLocalDiscoveryFailed(false); }}><ArrowLeft />{t("Providers", "选择 Provider")}</button>
      <div class="provider-onboarding-copy"><h3>{setupCatalogProvider?.name || setupLocalProvider?.name || t("Custom endpoint", "自定义端点")}</h3></div>
      <div class="provider-setup-fields">
        {setupCatalogProvider?.variants && <div class="provider-variant-picker">{setupCatalogProvider.variants.map((variant) => <button type="button" class={variant.id === setupVariantId ? "active" : ""} onClick={() => chooseCatalogVariant(variant)}>{variant.label}</button>)}</div>}
        {((!setupCatalogProvider && !setupLocalProvider) || setupRequiresEndpoint || (setupLocalProvider && showLocalEndpoint)) && <label>Base URL<input autoFocus={!setupCatalogProvider} value={setupEndpoint} placeholder={setupCatalogVariant?.endpointPlaceholder || setupCatalogProvider?.endpointPlaceholder || "https://your-provider.example/v1"} onInput={(event) => setSetupEndpoint(event.currentTarget.value)} /></label>}
        {!setupCatalogProvider && !setupLocalProvider && <label>{t("API format", "API 格式")}<select value={setupCustomApi} onChange={(event) => setSetupCustomApi(event.currentTarget.value as ProviderApi)}><option value="openai-completions">Chat Completions (/chat/completions)</option><option value="openai-responses">Responses (/responses)</option><option value="anthropic-messages">Anthropic Messages (/v1/messages)</option></select></label>}
        {!setupLocalProvider && <label>{setupCatalogVariant?.credentialLabel || setupCatalogProvider?.credentialLabel || "API key"} <span>{setupCatalogProvider ? t("required", "必填") : t("optional", "可选")}</span><div class="key-input"><KeyRound /><input autoFocus={Boolean(setupCatalogProvider && !setupRequiresEndpoint)} type="password" value={setupApiKey} placeholder={setupCatalogVariant?.credentialPlaceholder || setupCatalogProvider?.credentialPlaceholder || t("Leave blank when not required", "不需要时留空")} onInput={(event) => setSetupApiKey(event.currentTarget.value)} /></div>{setupCatalogProvider && <a class="auth-help" href={setupCatalogVariant?.authHelpUrl || setupCatalogProvider.authHelpUrl} target="_blank" rel="noreferrer">{t(setupCatalogVariant?.authHelpLabel || setupCatalogProvider.authHelpLabel, setupRequiresEndpoint ? "查看认证说明" : "获取 API key")}<ExternalLink /></a>}</label>}
        {!setupCatalogProvider && !setupLocalProvider && <label>{t("Model ID", "模型 ID")}<input value={setupModel} placeholder="model-name" onInput={(event) => setSetupModel(event.currentTarget.value)} /></label>}
        {setupLocalProvider && localDiscoveryFailed && <label>{t("Model ID", "模型 ID")}<input value={setupModel} placeholder="model-name" onInput={(event) => setSetupModel(event.currentTarget.value)} /></label>}
        {setupLocalProvider && !showLocalEndpoint && <button type="button" class="show-local-endpoint" onClick={() => setShowLocalEndpoint(true)}>{t("Use a different address", "使用其他地址")}</button>}
      </div>
      <div class="provider-setup-actions"><button type="button" class="setup-cancel" onClick={resetProviderSetup}>{t("Cancel", "取消")}</button><button type="submit" class="setup-primary" disabled={setupSubmitting || !setupEndpoint.trim() || Boolean(setupCatalogProvider && (!setupModel.trim() || !setupApiKey.trim())) || Boolean(!setupCatalogProvider && !setupLocalProvider && !setupModel.trim()) || Boolean(setupLocalProvider && localDiscoveryFailed && !setupModel.trim())}>{setupSubmitting ? t("Connecting…", "正在连接…") : inline ? t("Add provider", "添加 Provider") : t("Save and continue", "保存并继续")}</button></div>
    </>}
  </form>;
  return (
    <div class="veil settings-modal-veil" onPointerDown={(event) => event.target === event.currentTarget && close()}>
      <section class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onPointerDown={(event) => event.stopPropagation()}>
        <header class="settings-title">
          <div><h1 id="settings-title">{t("Settings", "设置")}</h1></div>
          <button class="icon settings-close" aria-label={t("Close settings", "关闭设置")} onClick={close}><X /></button>
        </header>
        <div class="settings-layout">
          <nav>
            <small>{t("Models", "模型")}</small>
            <button type="button" class={tab === "providers" ? "active" : ""} onPointerDown={() => setTab("providers")} onClick={() => setTab("providers")}><Server />{t("Providers", "Provider")}</button>
            <button type="button" disabled={!active} class={tab === "model" ? "active" : ""} onPointerDown={() => setTab("model")} onClick={() => setTab("model")}><Cpu />{t("Model defaults", "模型默认项")}</button>
            <small>{t("Preferences", "偏好设置")}</small>
            <button type="button" class={tab === "appearance" ? "active" : ""} onPointerDown={() => setTab("appearance")} onClick={() => setTab("appearance")}><Palette />{t("Appearance", "外观")}</button>
            <button type="button" class={tab === "agent" ? "active" : ""} onPointerDown={() => setTab("agent")} onClick={() => setTab("agent")}><SlidersHorizontal />Agent</button>
          </nav>
          <div class="settings-content">
            {tab === "providers" && <section>
              <div class="section-head"><div><h2>{t("Providers & deployments", "Provider 与部署")}</h2><p>{t("Define connections and each model deployment's context and output limits.", "定义连接，以及每个模型部署的 Context 与 Max output 上限。")}</p></div>{active && !addingProvider && <button class="add-provider" onClick={() => setAddingProvider(true)}><Plus />{t("Add provider", "添加 Provider")}</button>}</div>
              {!active ? providerSetup() : <div class="provider-layout">
                <div class="provider-list">{value.providers.map((provider) => <button class={provider.id === active.id ? "active" : ""} onClick={() => selectProvider(provider)}><ConfiguredProviderMark provider={provider} /><span><b>{provider.name}</b><small>{normalizeProviderModels(provider, provider.contextWindow).length} {t("deployments", "个部署")}</small></span>{provider.id === active.id && <Check />}</button>)}</div>
                <div class="provider-editor">
                  <div class="provider-editor-heading"><span><b>{t("Provider connection", "Provider 连接")}</b><small>{active.endpoint}</small></span><span class="deployment-count">{activeModels.length} {t(activeModels.length === 1 ? "deployment" : "deployments", "个部署")}</span><button class="remove-provider" title={t("Remove provider", "移除 Provider")} onClick={removeProvider}><Trash2 /></button></div>
                  <div class="provider-fields">
                    <label>{t("Name", "名称")}<input value={active.name} onInput={(event) => editProvider("name", event.currentTarget.value)} /></label>
                    <label>Base URL<input value={active.endpoint} onInput={(event) => editProvider("endpoint", event.currentTarget.value)} /></label>
                    <label class="wide">API key <span>{t("optional", "可选")}</span><div class="key-input"><KeyRound /><input type="password" value={active.apiKey} placeholder={t("Not required for most local servers", "多数本地服务不需要")} onInput={(event) => editProvider("apiKey", event.currentTarget.value)} /></div></label>
                  </div>
                  <p class="help">{t("Shun calls", "Shun 会调用")} <code>/models</code> {t("and", "和")} <code>/chat/completions</code>。</p>
                  <div class="provider-models-head"><span><b>{t("Deployments", "模型部署")}</b><small>{t("Each row defines one model ID and its hard context limits.", "每一行定义一个模型 ID 及其硬性上下文上限。")}</small></span><button class="add-provider" onClick={addModel}><Plus />{t("Add deployment", "添加部署")}</button></div>
                  <div class="provider-models">
                    <div class="provider-models-columns" aria-hidden="true"><span /><span>{t("Model ID", "模型 ID")}</span><span>Context</span><span>{t("Max output", "最大输出")}</span><span>{t("Test", "测试")}</span><span /></div>
                    {activeModels.map((model) => {
                      const test = deploymentTests[`${active.id}:${model.id}`], title = test ? `${test.message}${test.latencyMs === undefined ? "" : ` · ${test.latencyMs} ms`}` : t("Test deployment", "测试部署连通性");
                      return <div class={`provider-model-row ${model.id === value.model ? "active" : ""}`}>
                        <button class="model-select" title={t("Use this model", "使用此模型")} onClick={() => chooseModel(model.id)}><Check /></button>
                        <input aria-label={t("Model ID", "模型 ID")} value={model.id} onInput={(event) => editModel(model.id, "id", event.currentTarget.value)} />
                        <DeferredNumberInput label={t("Context window", "上下文窗口")} min={4096} step={4096} value={model.contextWindow} onCommit={(next) => editModel(model.id, "contextWindow", next)} />
                        <DeferredNumberInput label={t("Max output", "最大输出")} min={512} max={model.contextWindow} step={512} value={model.maxOutputTokens} onCommit={(next) => editModel(model.id, "maxOutputTokens", next)} />
                        <button type="button" class={`test-deployment ${test?.status || "idle"}`} aria-label={title} disabled={test?.status === "testing"} onClick={() => void testDeployment(model)}>{test?.status === "testing" ? <><LoaderCircle class="loading-spinner" /><span>{t("Testing", "测试中")}</span></> : test?.status === "success" ? <><Check /><span>OK</span></> : test?.status === "error" ? <><X /><span>{t("Retry", "重试")}</span></> : <><Play /><span>{t("Test", "测试")}</span></>}</button>
                        <button class="remove-model" aria-label={t("Remove model", "移除模型")} disabled={activeModels.length < 2} onClick={() => removeModel(model.id)}><Trash2 /></button>
                      </div>;
                    })}</div>
                </div>
              </div>}
            </section>}
            {tab === "model" && active && <section>
              <div class="section-head"><div><h2>{t("Model defaults", "模型默认项")}</h2><p>{t("Choose the deployment used by new requests and set its runtime behavior.", "选择新请求使用的部署，并设置请求时行为。")}</p></div></div>
              <div class="model-context-panel">
                <div class="model-settings-group deployment-settings">
                  <div class="model-settings-heading"><div><b>{t("Default deployment", "默认部署")}</b><p>{t("Providers define deployments; this page only chooses which one to use.", "Provider 负责定义部署；此处只选择使用哪个部署。")}</p></div><button type="button" class="model-settings-link" onClick={() => setTab("providers")}>{t("Manage providers", "管理 Provider")}</button></div>
                  <div class="deployment-selectors">
                    <label>Provider<span class="deployment-select-control"><select value={active.id} onChange={(event) => { const provider = value.providers.find((item) => item.id === event.currentTarget.value); if (provider) selectProvider(provider); }}>{value.providers.map((provider) => <option value={provider.id}>{provider.name}</option>)}</select><ChevronDown aria-hidden="true" /></span></label>
                    <label>{t("Model", "模型")}<span class="deployment-select-control"><select value={value.model} onChange={(event) => chooseModel(event.currentTarget.value)}>{activeModels.map((model) => <option value={model.id}>{model.name || model.id}</option>)}</select><ChevronDown aria-hidden="true" /></span></label>
                  </div>
                  <p class="deployment-endpoint">{active.endpoint}</p>
                </div>
                <div class="model-settings-group generation-settings">
                  <div class="model-settings-heading"><div><b>{t("Generation behavior", "生成行为")}</b><p>{t("Temperature changes answer variation without changing the deployment.", "Temperature 只改变回答的变化程度，不修改部署配置。")}</p></div><output>{value.temperature.toFixed(1)}</output></div>
                  <label class="temperature-control">
                    <span class="sr-only">Temperature</span>
                    <input type="range" min="0" max="2" step=".1" value={value.temperature} onInput={(event) => field("temperature", +event.currentTarget.value)} />
                    <span class="temperature-scale"><small>{t("More consistent", "更稳定")}</small><small>{t("More varied", "更多变化")}</small></span>
                  </label>
                </div>
                <div class="model-settings-group context-settings">
                  <div class="model-settings-heading"><div><b>{t("Deployment limits", "部署上限")}</b><p>{t("Read-only here. Context and output limits are edited under Providers.", "此处只读；Context 与 Max output 在 Provider 中编辑。")}</p></div><button type="button" class="model-settings-link" onClick={() => setTab("providers")}>{t("Edit limits", "编辑上限")}</button></div>
                  <div class="context-budget-summary"><strong>{contextWindow.toLocaleString()} <small>{t("total", "总窗口")}</small></strong><span>{t("Context budget for each request", "每次请求的上下文预算")}</span></div>
                  <div class="context-budget-bar" aria-label={t(`${conversationBudget.toLocaleString()} tokens for conversation, ${maxOutputTokens.toLocaleString()} reserved for output`, `对话可用 ${conversationBudget.toLocaleString()} token，输出预留 ${maxOutputTokens.toLocaleString()} token`)}><i style={`width:${outputShare}%`} /></div>
                  <div class="context-budget-legend">
                    <span><i class="conversation-swatch" /><small>{t("Conversation budget", "对话可用")}</small><b>{conversationBudget.toLocaleString()}</b></span>
                    <span><i class="output-swatch" /><small>{t("Max output", "最大输出")}</small><b>{maxOutputTokens.toLocaleString()}</b></span>
                  </div>
                  <div class="context-compaction-row"><span><b>{t("Automatic context management", "自动上下文管理")}</b><small>{t("Shun summarizes older turns before the conversation budget is exhausted.", "Shun 会在对话空间用尽前总结较早内容。")}</small></span><span class="always-on"><Check />{t("Always on", "始终启用")}</span></div>
                </div>
              </div>
            </section>}
            {tab === "appearance" && <section>
              <div class="section-head"><div><h2>{t("Appearance", "外观")}</h2><p>{t("Language, interface theme, and one shared accent color.", "语言、界面主题与统一强调色。")}</p></div></div>
              <div class="appearance-choice-list">
                <div class="appearance-choice-row"><div class="appearance-label"><Languages /><span><b>{t("Language", "语言")}</b><small>{t("Task output still follows the user.", "任务输出仍跟随用户语言。")}</small></span></div><div class="segmented three">{(["system", "en", "zh-CN"] as const).map((item) => <button class={value.language === item ? "active" : ""} onClick={() => field("language", item)}>{item === "system" ? t("System", "跟随系统") : item === "en" ? "English" : "简体中文"}</button>)}</div></div>
                <div class="appearance-choice-row"><div class="appearance-label"><Palette /><span><b>{t("Theme", "主题")}</b><small>{t("Mermaid diagrams switch with the interface.", "Mermaid 图表会随界面切换。")}</small></span></div><div class="segmented three">{(["system", "dark", "light"] as const).map((item) => <button class={value.theme === item ? "active" : ""} onClick={() => field("theme", item)}>{item === "system" ? t("System", "跟随系统") : item === "dark" ? t("Dark", "深色") : t("Light", "浅色")}</button>)}</div></div>
                <div class="appearance-choice-row"><div class="appearance-label"><span class={`accent-preview ${value.accent || "blue"}`} /><span><b>{t("Accent", "强调色")}</b><small>{t("Shared by selection, progress, context, and diagrams.", "统一用于选中、进度、上下文与图表。")}</small></span></div><div class="accent-options">{accentOptions.map((item) => <button class={value.accent === item ? "active" : ""} style={`--accent-swatch:${accentColor(item)}`} aria-label={item} title={item} onClick={() => field("accent", item)}><i /></button>)}</div></div>
              </div>
            </section>}
            {tab === "agent" && <section>
              <div class="section-head"><div><h2>{t("Agent runtime", "Agent 运行设置")}</h2><p>{t("Direct local tool execution.", "本地工具直接执行。")}</p></div></div>
              <div class="context-note"><SquareTerminal /><div><b>{t("Tools run automatically", "工具自动运行")}</b><p>{t("Shun does not add per-command permission popups. A workspace sets the working directory but is not a filesystem boundary; standalone tasks use a private internal working directory. Absolute paths use your account permissions. Project-local configuration and extensions use a separate startup trust decision. Use an OS sandbox, container, or VM when stronger isolation is required.", "Shun 不额外添加逐条命令批准弹窗。Workspace 只设置工作目录，并非文件系统边界；独立对话使用任务私有的内部工作目录。绝对路径按当前账户权限访问；项目本地配置和扩展使用独立的启动级信任决定。需要更强隔离时，请使用操作系统沙箱、容器或虚拟机。")}</p></div></div>
              <div class="session-actions"><div><b>{t("Task portability", "任务导入导出")}</b><p>{t("Move messages and tool history. Uploaded file binaries stay on this device.", "迁移消息与工具历史；上传文件的二进制内容保留在本机。")}</p></div><button onClick={importTask}><Upload />{t("Import", "导入")}</button><button onClick={exportTask}><Download />{t("Export current", "导出当前任务")}</button></div>
            </section>}
          </div>
        </div>
        {addingProvider && active && <div class="provider-dialog-veil" onPointerDown={(event) => event.target === event.currentTarget && resetProviderSetup()}>
          <div class="provider-dialog" role="dialog" aria-modal="true" aria-label={t("Add provider", "添加 Provider")} onPointerDown={(event) => event.stopPropagation()}>
            <button type="button" class="provider-dialog-close" aria-label={t("Close", "关闭")} onClick={resetProviderSetup}><X /></button>
            {providerSetup(true)}
          </div>
        </div>}
        {addingDeployment && active && <div class="provider-dialog-veil" onPointerDown={(event) => { if (event.target === event.currentTarget) { setAddingDeployment(false); setDeploymentQuery(""); } }}>
          <div class="provider-dialog deployment-library-dialog" role="dialog" aria-modal="true" aria-label={t("Add deployment", "添加部署")} onPointerDown={(event) => event.stopPropagation()}>
            <button type="button" class="provider-dialog-close" aria-label={t("Close", "关闭")} onClick={() => { setAddingDeployment(false); setDeploymentQuery(""); }}><X /></button>
            <div class="deployment-library">
              <h3>{t("Add deployment", "添加部署")}</h3>
              <label class="deployment-library-search"><Search /><input autoFocus value={deploymentQuery} placeholder={t(`Search ${activeCatalogProvider?.models.length || ""} models`, `搜索 ${activeCatalogProvider?.models.length || ""} 个模型`)} onInput={(event) => setDeploymentQuery(event.currentTarget.value)} /></label>
              {catalogLoading ? <p class="catalog-state"><LoaderCircle class="loading-spinner" />{t("Loading…", "加载中…")}</p> : <div class="deployment-library-list">
                {deploymentCandidates.map((model) => <button type="button" onClick={() => addCatalogDeployment(model)}><span><b>{model.name || model.id}</b>{model.name && model.name !== model.id && <small>{model.id}</small>}</span><span><small>{model.contextWindow.toLocaleString()} Context</small><Plus /></span></button>)}
                {!deploymentCandidates.length && <p class="deployment-library-empty">{normalizedDeploymentQuery ? t("No matching models", "没有匹配的模型") : t("Search by model name", "按模型名称搜索")}</p>}
              </div>}
            </div>
          </div>
        </div>}
      </section>
    </div>
  );
}

function PluginHub({
  value,
  update,
  notify,
  language,
  initialTab,
  sidebarOpen,
  revealSidebar,
}: {
  value: Settings;
  update: (fn: (x: Settings) => Settings) => void;
  notify: (input: ToastInput) => void;
  language: UiLanguage;
  initialTab: "plugins" | "skills";
  sidebarOpen: boolean;
  revealSidebar: () => void;
}) {
  const [plugins, setPlugins] = useState<PluginState[]>([]),
    [skills, setSkills] = useState<SkillState[]>([]),
    [connection, setConnection] = useState<Record<string, PluginConnectionState>>({}),
    [connecting, setConnecting] = useState(""),
    [figmaToken, setFigmaToken] = useState(""),
    [renderApiKey, setRenderApiKey] = useState(""),
    [cloudflareApiToken, setCloudflareApiToken] = useState(""),
    [editingAuthorization, setEditingAuthorization] = useState(""),
    [tab, setTab] = useState<"plugins" | "skills">(initialTab),
    [selectedId, setSelectedId] = useState(""),
    [pluginActionsOpen, setPluginActionsOpen] = useState(false),
    [skillDialog, setSkillDialog] = useState<"" | "create" | "install" | "detail">(""),
    [skillDocument, setSkillDocument] = useState<SkillDocument | null>(null),
    [skillName, setSkillName] = useState(""),
    [skillDescription, setSkillDescription] = useState(""),
    [skillInstructions, setSkillInstructions] = useState(""),
    [skillContent, setSkillContent] = useState(""),
    [skillPackageSource, setSkillPackageSource] = useState(""),
    [skillBusy, setSkillBusy] = useState(false),
    [skillDiscardOpen, setSkillDiscardOpen] = useState(false),
    t = (en: string, cn: string) => language === "zh" ? cn : en;

  useEffect(() => {
    setTab(initialTab);
    setPluginActionsOpen(false);
    setSelectedId("");
    setEditingAuthorization("");
  }, [initialTab]);

  useEffect(() => setEditingAuthorization(""), [selectedId]);

  useEffect(() => {
    let live = true;
    Promise.all([window.shun.plugins(value), window.shun.skills(value)]).then(([nextPlugins, nextSkills]) => {
      if (live) {
        setPlugins(nextPlugins);
        setSkills(nextSkills);
        for (const plugin of nextPlugins.filter((item) => item.installed)) {
          void window.shun.pluginConnection(plugin.id).then((state) => live && setConnection((current) => ({ ...current, [plugin.id]: state })));
        }
      }
    });
    return () => { live = false; };
  }, [value.plugins, value.skills, value.mcpServers]);

  useEffect(() => {
    if (selectedId !== "browser-use" || !findInstallation("browser-use")) return;
    let live = true;
    const poll = () => void window.shun.pluginConnection("browser-use").then((state) => {
      if (live) setConnection((current) => ({ ...current, "browser-use": state }));
    });
    poll();
    const timer = setInterval(poll, 1500);
    return () => { live = false; clearInterval(timer); };
  }, [selectedId, value.plugins]);

  const findInstallation = (pluginId: string) => (value.plugins || []).find((item) => item.id === pluginId),
    editInstallation = (pluginId: string, editor: (item: NonNullable<Settings["plugins"]>[number]) => NonNullable<Settings["plugins"]>[number]) => update((current) => ({
      ...current,
      plugins: (current.plugins || []).map((item) => item.id === pluginId ? editor(item) : item),
    })),
    editSkill = (skill: SkillState, enabled: boolean) => skill.pluginId
      ? editInstallation(skill.pluginId, (current) => ({
        ...current,
        skills: { ...(current.skills || {}), [skill.id]: enabled },
      }))
      : update((current) => ({
        ...current,
        skills: (current.skills || []).some((item) => item.id === skill.id)
          ? (current.skills || []).map((item) => item.id === skill.id ? { ...item, enabled } : item)
          : [...(current.skills || []), { id: skill.id, enabled }],
      })),
    install = (plugin: PluginState) => {
      update((current) => {
        const existing = (current.plugins || []).find((item) => item.id === plugin.id);
        if (existing) return {
          ...current,
          plugins: (current.plugins || []).map((item) => item === existing ? { ...item, enabled: true } : item),
        };
        return {
          ...current,
          plugins: [...(current.plugins || []), { id: plugin.id, enabled: true }],
        };
      });
      setPluginActionsOpen(false);
      setSelectedId(plugin.id);
      notify({ tone: "success", title: t(`${plugin.name} added`, `${plugin.name} 已添加`) });
    },
    remove = (plugin: PluginState) => {
      update((current) => ({
        ...current,
        plugins: (current.plugins || []).filter((item) => item.id !== plugin.id),
      }));
      if (plugin.id === "figma" || plugin.id === "browser-use" || plugin.id === "render" || plugin.id === "cloudflare") void window.shun.disconnectPlugin(plugin.id);
      setConnection((current) => { const next = { ...current }; delete next[plugin.id]; return next; });
      setPluginActionsOpen(false);
      setSelectedId("");
      setEditingAuthorization("");
    },
    connect = async (plugin: PluginState) => {
      if (plugin.id === "figma" && !figmaToken.trim()) {
        notify({ tone: "error", title: t("Figma token required", "请输入 Figma Token") });
        return;
      }
      if (plugin.id === "render" && !renderApiKey.trim()) {
        notify({ tone: "error", title: t("Render API key required", "请输入 Render API Key") });
        return;
      }
      if (plugin.id === "cloudflare" && !cloudflareApiToken.trim()) {
        notify({ tone: "error", title: t("Cloudflare API token required", "请输入 Cloudflare API Token") });
        return;
      }
      setConnecting(plugin.id);
      try {
        const credential = plugin.id === "figma" ? figmaToken.trim() : plugin.id === "render" ? renderApiKey.trim() : plugin.id === "cloudflare" ? cloudflareApiToken.trim() : undefined;
        const result = await window.shun.connectPlugin(plugin.id, credential), message = result.message;
        setConnection((current) => ({ ...current, [plugin.id]: result }));
        if (result.connected && plugin.id === "figma") setFigmaToken("");
        if (result.connected && plugin.id === "render") setRenderApiKey("");
        if (result.connected && plugin.id === "cloudflare") setCloudflareApiToken("");
        if (result.connected) setEditingAuthorization("");
        notify({
          tone: result.connected ? "success" : plugin.id === "browser-use" ? "info" : "error",
          title: result.connected ? t(`${plugin.name} connected`, `${plugin.name} 已连接`) : plugin.id === "browser-use" ? t("Chrome setup opened", "Chrome 设置已打开") : t(`${plugin.name} connection failed`, `${plugin.name} 连接失败`),
          message,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : t("Connection failed", "连接失败");
        setConnection((current) => ({ ...current, [plugin.id]: { connected: false, status: "error", message } }));
        notify({ tone: "error", title: t(`${plugin.name} connection failed`, `${plugin.name} 连接失败`), message });
      } finally { setConnecting(""); }
    },
    refreshSkills = async () => setSkills(await window.shun.skills(value)),
    skillDialogDirty = skillDialog === "create"
      ? Boolean(skillName.trim() || skillDescription.trim() || skillInstructions.trim())
      : skillDialog === "detail"
        ? Boolean(skillDocument?.skill.editable && skillContent !== skillDocument.content)
        : false,
    closeSkillDialog = () => {
      setSkillDialog("");
      setSkillDocument(null);
      setSkillName("");
      setSkillDescription("");
      setSkillInstructions("");
      setSkillContent("");
      setSkillPackageSource("");
      setSkillDiscardOpen(false);
    },
    requestCloseSkillDialog = () => {
      if (skillBusy) return;
      if (skillDialogDirty) setSkillDiscardOpen(true);
      else closeSkillDialog();
    },
    createSkill = async () => {
      setSkillBusy(true);
      try {
        const created = await window.shun.createSkill({ name: skillName.trim(), description: skillDescription.trim(), instructions: skillInstructions.trim() });
        await refreshSkills();
        closeSkillDialog();
        notify({ tone: "success", title: t(`${created.skill.name} created`, `${created.skill.name} 已创建`) });
      } catch (error) {
        notify({ tone: "error", title: t("Could not create Skill", "无法创建 Skill"), message: error instanceof Error ? error.message : String(error) });
      } finally { setSkillBusy(false); }
    },
    importSkills = async () => {
      setSkillBusy(true);
      try {
        const imported = await window.shun.importSkills(value);
        if (imported.length) {
          await refreshSkills();
          notify({ tone: "success", title: t(`${imported.length} Skill${imported.length === 1 ? "" : "s"} imported`, `已导入 ${imported.length} 个 Skill`) });
        }
      } catch (error) {
        notify({ tone: "error", title: t("Could not import Skill", "无法导入 Skill"), message: error instanceof Error ? error.message : String(error) });
      } finally { setSkillBusy(false); }
    },
    installSkillPackage = async () => {
      setSkillBusy(true);
      try {
        const installed = await window.shun.installSkillPackage(skillPackageSource.trim(), value);
        await refreshSkills();
        closeSkillDialog();
        notify({ tone: "success", title: t(`${installed.length} Skill${installed.length === 1 ? "" : "s"} installed`, `已安装 ${installed.length} 个 Skill`) });
      } catch (error) {
        notify({ tone: "error", title: t("Could not install Skill package", "无法安装 Skill Package"), message: error instanceof Error ? error.message : String(error) });
      } finally { setSkillBusy(false); }
    },
    openSkill = async (skill: SkillState) => {
      if (skill.origin === "plugin") return;
      setSkillBusy(true);
      try {
        const document = await window.shun.readSkill(skill.id, value);
        setSkillDocument(document);
        setSkillContent(document.content);
        setSkillDialog("detail");
      } catch (error) {
        notify({ tone: "error", title: t("Could not open Skill", "无法打开 Skill"), message: error instanceof Error ? error.message : String(error) });
      } finally { setSkillBusy(false); }
    },
    saveSkill = async () => {
      if (!skillDocument) return;
      setSkillBusy(true);
      try {
        const saved = await window.shun.updateSkill(skillDocument.skill.id, skillContent, value);
        setSkillDocument(saved);
        setSkillContent(saved.content);
        await refreshSkills();
        notify({ tone: "success", title: t("Skill saved", "Skill 已保存") });
      } catch (error) {
        notify({ tone: "error", title: t("Could not save Skill", "无法保存 Skill"), message: error instanceof Error ? error.message : String(error) });
      } finally { setSkillBusy(false); }
    },
    removeLocalSkill = async () => {
      if (!skillDocument) return;
      setSkillBusy(true);
      try {
        await window.shun.removeSkill(skillDocument.skill.id, value);
        update((current) => ({ ...current, skills: (current.skills || []).filter((item) => item.id !== skillDocument.skill.id) }));
        await refreshSkills();
        closeSkillDialog();
        notify({ tone: "success", title: t("Skill removed", "Skill 已移除") });
      } catch (error) {
        notify({ tone: "error", title: t("Could not remove Skill", "无法移除 Skill"), message: error instanceof Error ? error.message : String(error) });
      } finally { setSkillBusy(false); }
    },
    updateSkillPackage = async () => {
      const source = skillDocument?.skill.packageSource;
      if (!source) return;
      setSkillBusy(true);
      try {
        await window.shun.updateSkillPackage(source, value);
        await refreshSkills();
        const refreshed = await window.shun.readSkill(skillDocument!.skill.id, value);
        setSkillDocument(refreshed);
        setSkillContent(refreshed.content);
        notify({ tone: "success", title: t("Skill package updated", "Skill Package 已更新") });
      } catch (error) {
        notify({ tone: "error", title: t("Could not update Skill package", "无法更新 Skill Package"), message: error instanceof Error ? error.message : String(error) });
      } finally { setSkillBusy(false); }
    },
    removeSkillPackage = async () => {
      const source = skillDocument?.skill.packageSource;
      if (!source) return;
      setSkillBusy(true);
      try {
        await window.shun.removeSkillPackage(source, value);
        const packageSkillIds = new Set(skills.filter((item) => item.packageSource === source).map((item) => item.id));
        update((current) => ({ ...current, skills: (current.skills || []).filter((item) => !packageSkillIds.has(item.id)) }));
        await refreshSkills();
        closeSkillDialog();
        notify({ tone: "success", title: t("Skill package removed", "Skill Package 已移除") });
      } catch (error) {
        notify({ tone: "error", title: t("Could not remove Skill package", "无法移除 Skill Package"), message: error instanceof Error ? error.message : String(error) });
      } finally { setSkillBusy(false); }
    },
    installed = plugins.filter((plugin) => plugin.installed),
    installedSkills = skills.filter((skill) => skill.installed),
    selected = plugins.find((plugin) => plugin.id === selectedId);

  useEffect(() => {
    if (!skillDialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || skillBusy) return;
      event.preventDefault();
      if (skillDiscardOpen) setSkillDiscardOpen(false);
      else requestCloseSkillDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [skillDialog, skillDiscardOpen, skillBusy, skillDialogDirty]);

  return <>
    <header class="plugin-hub-toolbar">
      {!sidebarOpen && <button class="sidebar-reveal" aria-label={t("Show sidebar", "显示侧栏")} title={t("Show sidebar", "显示侧栏")} onClick={revealSidebar}><PanelLeftOpen /></button>}
      <nav class="plugin-kind-tabs" aria-label={t("Plugin and skill sections", "插件与 Skill 分类")}>
        <button class={tab === "plugins" ? "active" : ""} onClick={() => { setTab("plugins"); setPluginActionsOpen(false); setSelectedId(""); }}>Plugins</button>
        <button class={tab === "skills" ? "active" : ""} onClick={() => { setTab("skills"); setPluginActionsOpen(false); setSelectedId(""); }}>Skills</button>
      </nav>
    </header>
    <div class="plugin-hub-scroll">
      <div class="plugin-hub-content">
        {tab === "skills" ? <>
          <div class="plugin-page-heading skill-page-heading"><span><h1>Skills</h1><p>{t("Agent Skills use the open SKILL.md format and load progressively only when relevant.", "Agent Skill 使用开放的 SKILL.md 格式，并仅在相关时渐进加载。")}</p></span><div class="skill-heading-actions"><button disabled={skillBusy} onClick={() => void importSkills()}><Upload />{t("Import", "导入")}</button><button disabled={skillBusy} onClick={() => setSkillDialog("install")}><Download />{t("Install package", "安装 Package")}</button><button class="primary" disabled={skillBusy} onClick={() => setSkillDialog("create")}><Plus />{t("Create", "创建")}</button></div></div>
          {!!installedSkills.length ? <section class="plugin-hub-section installed-section"><h2>{t("Installed", "已安装")}</h2><div class="skill-grid">{installedSkills.map((skill) => {
            const plugin = skill.pluginId ? plugins.find((item) => item.id === skill.pluginId) : undefined;
            const pluginUnavailable = Boolean(plugin && !plugin.enabled);
            const toggleLabel = skill.enabled ? t(`Disable ${skill.name}`, `关闭 ${skill.name}`) : t(`Enable ${skill.name}`, `启用 ${skill.name}`);
            const sourceLabel = plugin ? t(`From ${plugin.name} plugin`, `来自 ${plugin.name} 插件`) : skill.origin === "local" ? t("Local Skill", "本地 Skill") : skill.origin === "package" ? t("Skill package", "Skill Package") : skill.origin === "project" ? t("Project Skill", "项目 Skill") : t("External Skill", "外部 Skill");
            return <div class={`skill-row ${pluginUnavailable ? "plugin-disabled" : ""} ${plugin ? "" : "managed-skill"}`} key={skill.id}>{plugin ? <PluginLogo plugin={plugin} /> : <span class="plugin-logo skill-logo" aria-hidden="true"><Puzzle /></span>}<button class="skill-main" disabled={Boolean(plugin)} onClick={() => void openSkill(skill)}><b>{skill.name}</b><small>{skill.description}</small><em>{sourceLabel}</em></button><label class="plugin-switch" title={pluginUnavailable ? t(`${plugin!.name} plugin is off`, `${plugin!.name} 插件已关闭`) : toggleLabel}><input aria-label={toggleLabel} type="checkbox" checked={skill.enabled} disabled={pluginUnavailable} onChange={(event) => editSkill(skill, event.currentTarget.checked)} /><i /></label></div>;
          })}</div></section> : <div class="skills-empty"><Puzzle /><b>{t("No skills yet", "还没有 Skill")}</b><p>{t("Installed Skills will appear here.", "已安装的 Skill 会显示在这里。")}</p></div>}
        </> : <>
          <div class="plugin-page-heading"><h1>Plugins</h1></div>
          {!!installed.length && <section class="plugin-hub-section installed-section"><h2>{t("Installed", "已安装")}</h2><div class="installed-plugin-strip">{installed.map((plugin) => <button title={plugin.name} aria-label={plugin.name} onClick={() => { setPluginActionsOpen(false); setSelectedId(plugin.id); }}><PluginLogo plugin={plugin} /></button>)}</div></section>}
          <section class="plugin-hub-section catalog-section"><h2>{t("Available plugins", "可用插件")}</h2>
            <div class="plugin-catalog-grid">{plugins.map((plugin) => <div class="plugin-catalog-row"><PluginLogo plugin={plugin} /><span><b>{plugin.name}</b><small>{plugin.description}</small></span>{plugin.installed ? <button class="plugin-more" aria-label={t(`Manage ${plugin.name}`, `管理 ${plugin.name}`)} onClick={() => { setPluginActionsOpen(false); setSelectedId(plugin.id); }}><MoreHorizontal /></button> : <button class="plugin-install" onClick={() => install(plugin)}>{t("Install", "安装")}</button>}</div>)}</div>
          </section>
        </>}
      </div>
    </div>
    {skillDialog === "create" && <div class="plugin-dialog-backdrop skill-editor-backdrop"><section class="plugin-dialog skill-editor-dialog" role="dialog" aria-modal="true" aria-label={t("Create Skill", "创建 Skill")}><header><span class="plugin-logo skill-logo"><Puzzle /></span><span><h2>{t("Create Skill", "创建 Skill")}</h2><small>{t("Agent Skills standard · local", "Agent Skills 标准 · 本地")}</small></span><span /><button class="plugin-dialog-close" aria-label={t("Close", "关闭")} onClick={requestCloseSkillDialog}><X /></button></header><div class="plugin-dialog-body skill-form"><label><span>{t("Name", "名称")}</span><input autoFocus value={skillName} placeholder="design-review" onInput={(event) => setSkillName(event.currentTarget.value.toLowerCase())} /><small>{t("Lowercase letters, numbers, and single hyphens.", "使用小写字母、数字和单个连字符。")}</small></label><label><span>{t("Description", "描述")}</span><textarea value={skillDescription} placeholder={t("What it does and when the agent should use it.", "说明它做什么，以及 Agent 应在何时使用。")} onInput={(event) => setSkillDescription(event.currentTarget.value)} /></label><label><span>{t("Instructions", "指令")}</span><textarea class="skill-instructions" value={skillInstructions} placeholder={t("Write the workflow in Markdown…", "用 Markdown 编写工作流程…")} onInput={(event) => setSkillInstructions(event.currentTarget.value)} /></label></div><footer><span /><button class="plugin-primary" disabled={skillBusy || !skillName.trim() || !skillDescription.trim() || !skillInstructions.trim()} onClick={() => void createSkill()}>{skillBusy ? <LoaderCircle class="loading-spinner" /> : <Plus />}{t("Create Skill", "创建 Skill")}</button></footer></section></div>}
    {skillDialog === "install" && <div class="plugin-dialog-backdrop" onPointerDown={(event) => event.target === event.currentTarget && closeSkillDialog()}><section class="plugin-dialog skill-package-dialog" role="dialog" aria-modal="true" aria-label={t("Install Skill package", "安装 Skill Package")} onPointerDown={(event) => event.stopPropagation()}><header><span class="plugin-logo skill-logo"><Download /></span><span><h2>{t("Install Skill package", "安装 Skill Package")}</h2><small>npm · git · local path</small></span><span /><button class="plugin-dialog-close" aria-label={t("Close", "关闭")} onClick={closeSkillDialog}><X /></button></header><div class="plugin-dialog-body skill-form"><label><span>{t("Package source", "Package 来源")}</span><input autoFocus value={skillPackageSource} placeholder="https://github.com/user/agent-skills" onInput={(event) => setSkillPackageSource(event.currentTarget.value)} /></label><div class="skill-security-note"><KeyRound /><span><b>{t("Review third-party Skills before installing.", "安装前请审查第三方 Skill。")}</b><small>{t("Shun exposes only the source’s Skills. Package installation or isolated script dependency preparation may execute third-party package-manager code; Skill scripts themselves are not run during installation.", "Shun 只加载来源中的 Skill。安装 Package 或准备隔离的脚本依赖时可能执行第三方包管理器代码；安装期间不会运行 Skill 脚本本身。")}</small></span></div></div><footer><a href="https://agentskills.io" target="_blank" rel="noreferrer">{t("Agent Skills format", "Agent Skills 格式")}<ExternalLink /></a><button class="plugin-primary" disabled={skillBusy || !skillPackageSource.trim()} onClick={() => void installSkillPackage()}>{skillBusy ? <LoaderCircle class="loading-spinner" /> : <Download />}{t("Install", "安装")}</button></footer></section></div>}
    {skillDialog === "detail" && skillDocument && <div class="plugin-dialog-backdrop skill-editor-backdrop"><section class="plugin-dialog skill-editor-dialog skill-detail-dialog" role="dialog" aria-modal="true" aria-label={skillDocument.skill.name}><header><span class="plugin-logo skill-logo"><Puzzle /></span><span><h2>{skillDocument.skill.name}</h2><small>{skillDocument.skill.origin === "local" ? t("Local Skill", "本地 Skill") : skillDocument.skill.origin === "package" ? skillDocument.skill.packageSource : skillDocument.skill.origin === "project" ? t("Project Skill", "项目 Skill") : t("External Skill", "外部 Skill")}</small></span><span /><button class="plugin-dialog-close" aria-label={t("Close", "关闭")} onClick={requestCloseSkillDialog}><X /></button></header><div class="plugin-dialog-body skill-document"><textarea readOnly={!skillDocument.skill.editable} value={skillContent} onInput={(event) => setSkillContent(event.currentTarget.value)} /><small>{skillDocument.skill.editable ? t("Edit the Agent Skills-compatible SKILL.md directly. The name cannot change in place.", "直接编辑兼容 Agent Skills 的 SKILL.md；名称不能原地修改。") : skillDocument.skill.origin === "package" ? t("Package Skills are read-only. Update or remove the source package instead.", "Package Skill 为只读；请更新或移除来源 Package。") : t("This Skill is managed outside Shun.", "此 Skill 由 Shun 外部管理。")}</small></div><footer><div class="skill-detail-secondary">{skillDocument.skill.filePath && <button onClick={() => void window.shun.openWorkspace(skillDocument.skill.filePath!)}><FolderOpen />{t("Open file", "打开文件")}</button>}{skillDocument.skill.origin === "local" && <button class="skill-remove" disabled={skillBusy} onClick={() => void removeLocalSkill()}><Trash2 />{t("Remove", "移除")}</button>}{skillDocument.skill.origin === "package" && <><button disabled={skillBusy} onClick={() => void updateSkillPackage()}><RotateCcw />{t("Update", "更新")}</button><button class="skill-remove" disabled={skillBusy} onClick={() => void removeSkillPackage()}><Trash2 />{t("Remove package", "移除 Package")}</button></>}</div>{skillDocument.skill.editable && <button class="plugin-primary" disabled={skillBusy || skillContent === skillDocument.content} onClick={() => void saveSkill()}>{skillBusy ? <LoaderCircle class="loading-spinner" /> : <Check />}{t("Save", "保存")}</button>}</footer></section></div>}
    {skillDiscardOpen && <div class="skill-discard-backdrop"><section class="skill-discard-dialog" role="alertdialog" aria-modal="true" aria-labelledby="skill-discard-title" aria-describedby="skill-discard-description"><h3 id="skill-discard-title">{t("Discard unsaved changes?", "放弃未保存的更改？")}</h3><p id="skill-discard-description">{t("Your edits will be lost. This action cannot be undone.", "你的编辑内容将会丢失，且无法恢复。")}</p><footer><button onClick={() => setSkillDiscardOpen(false)}>{t("Keep editing", "继续编辑")}</button><button class="danger" onClick={closeSkillDialog}>{t("Discard", "放弃更改")}</button></footer></section></div>}
    {selected && (() => {
      const installation = findInstallation(selected.id), enabled = Boolean(installation) && installation?.enabled !== false,
        connectionState = connection[selected.id], credentialPlugin = selected.connector.auth === "pat" || selected.connector.auth === "api-key",
        authorizationExpanded = !connectionState?.connected || editingAuthorization === selected.id;
      return <div class="plugin-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) { setPluginActionsOpen(false); setSelectedId(""); } }}>
        <section class="plugin-dialog" role="dialog" aria-modal="true" aria-label={selected.name} onPointerDown={(event) => event.stopPropagation()}>
          <header><PluginLogo plugin={selected} /><span><h2>{selected.name}</h2><small>{selected.publisher}</small></span><div class="plugin-dialog-actions">{installation && <><button class="plugin-dialog-more" aria-label={t("Plugin actions", "插件操作")} aria-expanded={pluginActionsOpen} onClick={() => setPluginActionsOpen((open) => !open)}><MoreHorizontal /></button>{pluginActionsOpen && <div class="plugin-dialog-menu" role="menu">{connectionState?.connected && credentialPlugin && <button role="menuitem" onClick={() => { setEditingAuthorization(selected.id); setPluginActionsOpen(false); }}><KeyRound />{t("Modify", "修改")}</button>}<button class="danger" role="menuitem" onClick={() => remove(selected)}><Trash2 />{t("Remove", "移除")}</button></div>}</>}</div><button class="plugin-dialog-close" aria-label={t("Close", "关闭")} onClick={() => { setPluginActionsOpen(false); setSelectedId(""); }}><X /></button></header>
          {!installation ? <div class="plugin-dialog-body"><p>{selected.description}</p><button class="plugin-primary" onClick={() => install(selected)}>{t("Install", "安装")}</button></div> : <>
            <div class="plugin-dialog-body">
              <div class="plugin-connection-row"><span><b>{t("Connection", "连接状态")}</b><small>{selected.id === "github" ? t("Uses the verified GitHub CLI login on this device. Shun never reads or stores its token.", "使用这台设备上已验证的 GitHub CLI 登录；Shun 不读取或保存 Token。") : selected.id === "browser-use" ? t("Uses the Shun Chrome extension to control explicitly claimed tabs with your existing login state, cookies, and extensions.", "通过 Shun Chrome 扩展控制明确认领的标签页，并复用现有登录状态、Cookie 与扩展环境。") : selected.id === "render" ? t("Uses a Render API key encrypted by the operating system. The plugin does not expose environment variables or secret files.", "使用由操作系统加密保存的 Render API Key；插件不会暴露环境变量或 Secret Files。") : selected.id === "cloudflare" ? t("Uses a scoped Cloudflare API token encrypted by the operating system. Environment variables, bindings, and secret values are removed at the tool boundary.", "使用由操作系统加密保存的 Cloudflare 范围化 API Token；环境变量、绑定和 Secret 值会在工具边界内剔除。") : t("Uses a read-only Figma Personal Access Token. The token is encrypted by the operating system.", "使用只读 Figma Personal Access Token；Token 由操作系统加密保存。")}</small></span><span class={`plugin-auth-state ${connectionState?.connected ? "authorized" : ""}`} title={connectionState?.account || undefined}>{connectionState?.connected && <Check />}<span>{!connectionState ? t("Checking…", "检查中…") : connectionState.connected ? `${t("Connected", "已连接")}${connectionState.account ? ` · ${connectionState.account}` : ""}` : t("Not connected", "未连接")}</span></span></div>
              {connectionState?.connected && <div class="plugin-connection-row plugin-enabled-row"><span><b>{t("Available to tasks", "允许任务使用")}</b><small>{t("Expose this plugin's bounded tools and Skills to tasks.", "向任务提供该插件的受限工具和 Skills。")}</small></span><label class="plugin-switch"><input type="checkbox" checked={enabled} onChange={(event) => editInstallation(selected.id, (current) => ({ ...current, enabled: event.currentTarget.checked }))} /><i /><span>{enabled ? t("On", "已开启") : t("Off", "已关闭")}</span></label></div>}
              {authorizationExpanded && selected.id === "figma" && <label class="plugin-token-field"><span>Personal Access Token</span><input type="password" value={figmaToken} autocomplete="off" placeholder="figd_…" onInput={(event) => { setFigmaToken(event.currentTarget.value); if (connection.figma?.status === "error") setConnection((current) => ({ ...current, figma: { connected: false, status: "disconnected" } })); }} /><small>{connectionState?.connected ? t("Enter a new token only to replace the current connection.", "仅在需要更换当前连接时输入新 Token。") : t("Paste a Figma token, then select Connect. It needs current_user:read and file_content:read; full variables also require file_variables:read and an eligible Enterprise plan.", "粘贴 Figma Token 后点击“连接”。Token 需要 current_user:read 和 file_content:read；完整变量还需要 file_variables:read 和符合条件的 Enterprise 方案。")}</small></label>}
              {authorizationExpanded && selected.id === "render" && <label class="plugin-token-field"><span>API Key</span><input type="password" value={renderApiKey} autocomplete="off" placeholder="rnd_…" onInput={(event) => { setRenderApiKey(event.currentTarget.value); if (connection.render?.status === "error") setConnection((current) => ({ ...current, render: { connected: false, status: "disconnected" } })); }} /><small>{connectionState?.connected ? t("Enter a new API key only to replace the current connection.", "仅在需要更换当前连接时输入新的 API Key。") : t("Create an API key in Render Account Settings, paste it here, then select Connect.", "在 Render Account Settings 中创建 API Key，粘贴到这里后点击“连接”。")}</small></label>}
              {authorizationExpanded && selected.id === "cloudflare" && <label class="plugin-token-field"><span>API Token</span><input type="password" value={cloudflareApiToken} autocomplete="off" placeholder="cfut_…" onInput={(event) => { setCloudflareApiToken(event.currentTarget.value); if (connection.cloudflare?.status === "error") setConnection((current) => ({ ...current, cloudflare: { connected: false, status: "disconnected" } })); }} /><small>{connectionState?.connected ? t("Enter a new API token only to replace the current connection.", "仅在需要更换当前连接时输入新的 API Token。") : t("Create a scoped token with only the account, zone, DNS, Workers, Pages, and cache permissions you need, paste it here, then select Connect.", "创建仅包含所需账户、Zone、DNS、Workers、Pages 和缓存权限的范围化 Token，粘贴到这里后点击“连接”。")}</small></label>}
              {connectionState?.message && (connectionState.status === "error" || connectionState.status === "unavailable") && <div class="plugin-auth-message"><X />{connectionState.message}</div>}
            </div>
            {(!connectionState?.connected || !credentialPlugin || authorizationExpanded) && <footer>{selected.connector.setupUrl && <a href={selected.connector.setupUrl} target="_blank" rel="noreferrer">{t("Setup guide", "配置指南")}<ExternalLink /></a>}{(!connectionState?.connected || credentialPlugin || selected.id === "browser-use") && <button class="plugin-primary" disabled={connecting === selected.id || !connectionState || (selected.id === "figma" && !figmaToken.trim()) || (selected.id === "render" && !renderApiKey.trim()) || (selected.id === "cloudflare" && !cloudflareApiToken.trim())} onClick={() => void connect(selected)}>{connecting === selected.id ? <><LoaderCircle class="loading-spinner" />{selected.id === "browser-use" ? t("Opening Chrome…", "正在打开 Chrome…") : credentialPlugin ? t("Testing connection…", "正在测试连接…") : t("Authorizing…", "授权中…")}</> : <>{selected.id === "browser-use" ? <Cable /> : <KeyRound />}{selected.id === "browser-use" ? connectionState?.connected ? t("Update extension", "更新扩展") : t("Set up Chrome", "设置 Chrome") : connectionState?.connected ? t("Update authorization", "更新授权") : t("Authorize", "授权")}</>}</button>}</footer>}
          </>}
        </section>
      </div>;
    })()}
  </>;
}

function PluginLogo({ plugin, large = false }: { plugin: PluginState; large?: boolean }) {
  return <span class={`plugin-logo ${plugin.icon} ${large ? "large" : ""}`} aria-hidden="true">
    <PluginLogoGlyph icon={plugin.icon} />
  </span>;
}

function PluginLogoGlyph({ icon }: { icon: PluginState["icon"] }) {
  return icon === "figma" ? <span class="figma-glyph"><i /><i /><i /><i /><i /></span> : icon === "github" ? <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.29-1.69-1.29-1.69-1.05-.72.08-.7.08-.7 1.17.08 1.78 1.2 1.78 1.2 1.04 1.77 2.72 1.26 3.38.96.1-.75.4-1.26.74-1.55-2.57-.29-5.27-1.29-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18A11 11 0 0 1 12 6.13c.98 0 1.95.13 2.86.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.06.79 2.14v3.24c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" /></svg> : icon === "chrome" ? <span class="chrome-glyph"><i /></span> : icon === "render" ? <RenderLogo /> : icon === "cloudflare" ? <CloudflareLogo /> : <Puzzle />;
}

function RenderLogo() {
  return <svg class="render-glyph" viewBox="206 194 400 400" fill="currentColor" aria-hidden="true">
    <path d="M605.28 288.733C605.221 287.368 605.102 286.033 604.984 284.668C604.954 284.342 604.954 283.986 604.894 283.659C604.805 282.829 604.687 282.027 604.568 281.197C604.449 280.336 604.36 279.506 604.241 278.675C604.152 278.082 604.034 277.488 603.915 276.924C603.737 275.886 603.559 274.818 603.351 273.78C603.173 272.949 602.965 272.148 602.787 271.317C602.609 270.516 602.431 269.745 602.253 268.944C602.045 268.113 601.778 267.312 601.54 266.481C601.333 265.71 601.125 264.968 600.887 264.197C600.62 263.366 600.323 262.535 600.027 261.704C599.789 260.992 599.552 260.28 599.314 259.568C598.928 258.53 598.513 257.521 598.127 256.512C597.919 256.008 597.741 255.533 597.533 255.029C597.058 253.931 596.584 252.863 596.079 251.795C595.901 251.409 595.723 250.994 595.545 250.608C595.07 249.599 594.535 248.62 594.031 247.641C593.793 247.196 593.586 246.751 593.348 246.306C592.755 245.208 592.102 244.111 591.478 243.043C591.3 242.746 591.152 242.449 590.974 242.153C590.291 241.025 589.579 239.927 588.837 238.83C588.688 238.592 588.54 238.355 588.391 238.118C587.501 236.812 586.581 235.507 585.631 234.231C584.741 233.044 583.82 231.857 582.871 230.7C582.811 230.611 582.752 230.522 582.663 230.433C564.319 208.211 536.626 194.089 505.609 194.059V194L505.52 194.059H505.549C496.942 194.059 488.571 195.157 480.587 197.204C475.808 198.421 471.148 200.023 466.666 201.892C465.182 202.515 463.698 203.197 462.243 203.88C432.769 218.061 411.398 246.306 406.679 279.891H406.62C404.542 294.281 400.119 307.899 393.827 320.419H394.035C372.129 363.854 327.132 393.671 275.129 393.671C251.918 393.671 230.131 387.738 211.135 377.324C208.909 376.107 206.208 377.71 206.208 380.231V393.671H206V593.254H405.7V493.448H405.907V443.545C405.907 415.982 428.258 393.642 455.832 393.642H505.757C514.305 393.642 522.587 392.544 530.512 390.497C535.291 389.251 539.951 387.678 544.433 385.809C545.917 385.186 547.401 384.504 548.855 383.821C579.398 369.106 601.303 339.288 604.894 304.071C605.221 300.719 605.399 297.307 605.399 293.865C605.399 292.145 605.369 290.424 605.28 288.733Z" />
  </svg>;
}

function CloudflareLogo() {
  return <svg class="cloudflare-glyph" viewBox="0 0 209.51 94.74" aria-hidden="true">
    <path fill="#f4801f" d="M143.05 93.42l1.07-3.71c1.27-4.41.8-8.48-1.34-11.48-2-2.76-5.26-4.38-9.25-4.57L58 72.7a1.47 1.47 0 0 1-1.35-2 2 2 0 0 1 1.75-1.34l76.26-1c9-.41 18.84-7.75 22.27-16.71l4.34-11.36a2.68 2.68 0 0 0 .18-1 3.31 3.31 0 0 0-.06-.54 49.67 49.67 0 0 0-95.49-5.14 22.35 22.35 0 0 0-35 23.42A31.73 31.73 0 0 0 .34 93.45a1.47 1.47 0 0 0 1.45 1.27l139.49 0a1.83 1.83 0 0 0 1.77-1.3Z" />
    <path fill="#f9ab41" d="M168.22 41.15q-1 0-2.1.06a.88.88 0 0 0-.32.07 1.17 1.17 0 0 0-.76.8l-3 10.26c-1.28 4.41-.81 8.48 1.34 11.48a11.65 11.65 0 0 0 9.24 4.57l16.11 1a1.44 1.44 0 0 1 1.14.62 1.5 1.5 0 0 1 .17 1.37 2 2 0 0 1-1.75 1.34l-16.73 1c-9.09.42-18.88 7.75-22.31 16.7l-1.21 3.16a.9.9 0 0 0 .79 1.22h57.63a1.55 1.55 0 0 0 1.54-1.17 41.34 41.34 0 0 0-39.76-52.48Z" />
  </svg>;
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
  const persistedTasks = keepCurrentDraft(tasks, currentId, hasTaskContent)
    .map((task) => ({
      ...task,
      turns: task.turns.map((turn) =>
        turn.timeline?.some((entry) => entry.type === "tool")
          ? { ...turn, tools: undefined }
          : turn,
      ),
    }));
  return {
    settings: { ...settings, autoCompact: true },
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
function applyBufferedEvents(tasks: Task[], events: AgentEvent[]) {
  if (!events.length) return tasks;
  const byRun = new Map<string, AgentEvent[]>();
  for (const event of events) byRun.set(event.id, [...(byRun.get(event.id) || []), event]);
  return tasks.map((task) => {
    let changed = false;
    const turns = task.turns.map((turn) => {
      const updates = byRun.get(turn.id);
      if (!updates?.length) return turn;
      changed = true;
      return updates.reduce(applyEvent, turn);
    });
    return changed ? { ...task, turns, updatedAt: Date.now() } : task;
  });
}
function applyEvent(turn: Turn, event: AgentEvent): Turn {
  const now = Date.now();
  if (event.type === "delta") {
    const current = settleTurnCompaction(turn),
      text = event.text || "";
    return {
      ...current,
      content: current.content + text,
      timeline: appendText(current.timeline, text),
      lastActivityAt: now,
    };
  }
  if (event.type === "phase")
    return { ...settleTurnCompaction(turn), phase: event.text || "Thinking", lastActivityAt: now };
  if (event.type === "progress" && event.progress)
    return {
      ...settleTurnCompaction(turn),
      progress: event.progress,
      phase:
        event.progress.state === "complete"
          ? ""
          : sentence(event.progress.stage),
      lastActivityAt: now,
    };
  if (event.type === "reasoning")
    return { ...settleTurnCompaction(turn), phase: "Thinking", lastActivityAt: now };
  if (event.type === "context" && event.context)
    return {
      ...turn,
      contextUsage: event.context,
      timeline: upsertContext(turn.timeline, event.context),
      lastActivityAt: now,
    };
  if (event.type === "tool" && event.tool)
    return {
      ...settleTurnCompaction(turn),
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
  language,
}: {
  value?: NonNullable<Turn["contextUsage"]>;
  modelWindow: number;
  maxOutputTokens: number;
  language: UiLanguage;
}) {
  const zh = language === "zh",
    configuredOutput = Math.min(
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
    remaining = Math.max(0, budget - used),
    breakdown = value?.breakdown,
    breakdownRows = [
      [zh ? "系统提示词" : "System prompt", breakdown?.systemTokens, "system"],
      [zh ? "工具" : "Tools", breakdown?.toolTokens, "tools"],
      [zh ? "MCP 桥接" : "MCP bridge", breakdown?.mcpTokens, "mcp"],
      [zh ? "对话" : "Conversation", breakdown?.conversationTokens, "conversation"],
    ] as const;
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
        aria-label={zh ? "查看上下文用量" : "Show context usage"}
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
        <div class="context-popover" role="dialog" aria-label={zh ? "上下文用量" : "Context usage"}>
          <header>
            <span>{zh ? "上下文" : "Context"}</span>
            <em>{value?.exactTokens ? (zh ? "总量准确" : "Total exact") : (zh ? "估算" : "Estimated")}</em>
          </header>
          <strong>
            {compactCount(used)} <small>/ {compactCount(budget)} tokens</small>
          </strong>
          <div class="context-progress">
            <i style={{ width: `${percent}%` }} />
          </div>
          <dl>
            <div>
              <dt>{zh ? "已使用" : "Used"}</dt>
              <dd>
                {compactCount(used)} tokens
              </dd>
            </div>
            <div>
              <dt>{zh ? "可用" : "Available"}</dt>
              <dd>{compactCount(remaining)} {zh ? "tokens 可用" : "tokens left"}</dd>
            </div>
            <div>
              <dt>{zh ? "输出上限" : "Output limit"}</dt>
              <dd>{compactCount(maxOutputTokens)} tokens</dd>
            </div>
            <div>
              <dt>{zh ? "模型窗口" : "Model window"}</dt>
              <dd>{compactCount(modelWindow)} tokens</dd>
            </div>
          </dl>
          <section class="context-breakdown" aria-label={zh ? "上下文构成估算" : "Estimated context breakdown"}>
            <div class="context-breakdown-heading">
              <span>{zh ? "构成" : "Breakdown"}</span>
              <small title={breakdown
                ? (zh ? "根据当前系统提示词和工具定义估算" : "Estimated from the active system prompt and tool schemas")
                : (zh ? "旧任务将在下一次模型请求后更新" : "Legacy usage updates after the next model request")}
              >{breakdown ? (zh ? "估算" : "Estimated") : (zh ? "待更新" : "Pending")}</small>
            </div>
            <ul>
              {breakdownRows.map(([label, tokens, kind]) => (
                <li class={`context-breakdown-${kind}`} key={kind}>
                  <span><i />{label}</span>
                  <strong class={tokens == null ? "missing" : undefined}>{tokens == null ? "—" : compactCount(tokens)}</strong>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
function contextTokens(value: NonNullable<Turn["contextUsage"]>) {
  return value.usedTokens || Math.ceil(value.usedCharacters / 2.5);
}
function compactCount(value: number) {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
    : value >= 1000
    ? `${(value / 1000).toFixed(1).replace(/\.0$/, "")}K`
    : String(value);
}
function thinkingLabel(phase: string, language: UiLanguage) {
  return /^(?:Thinking|Working)$/.test(phase)
    ? language === "zh"
      ? "思考中"
      : "Thinking"
    : phase.replace(/\.*$/, "");
}
function useElapsedClock(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000)),
    minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
function sentence(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}
