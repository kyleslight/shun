import { useEffect, useRef, useState } from 'preact/hooks'
import type {
  PluginManifest, PluginViewContribution, PluginViewLaunchSource, PluginViewLocation, PluginViewRailPolicy, PluginWorkspaceRequirement,
  RemoteDesktopConnectionEvent, RemoteDesktopEventBatch, RemoteDesktopState, RemoteDeviceState, RemoteTerminalFrame, RemoteUploadedAttachment, WorkspaceDirectoryListing,
} from '../../shared'
import {
  appendOptimisticTurn, applyRemoteEvents, applyRemoteHistory, applyRemoteSnapshot, catchUpContinues, emptyRemoteTaskView, newestSettledToolId, removeOptimisticTurn,
  type RemoteAttachment, type RemoteChangeEntry, type RemoteChangesState, type RemoteDiffEntry, type RemoteEvent, type RemoteResource,
  type RemoteQueueItem, type RemoteSnapshot, type RemoteTaskSummary, type RemoteTaskView, type RemoteToolRecord, type RemoteTurn,
  type RemoteWorkspaceDirectory,
} from './remote-conversation'
import { remoteFailureText } from '../../shared'

/** How long a remote task may go with the two sides disagreeing before it is read whole. */
export const REMOTE_LIVE_RECOVERY_MS = 10_000
/**
 * How many unanswered reads, while the view believes a run is going, are
 * silence rather than a slow answer. One read can be lost with the link that
 * carried it; a second one after a full interval is the peer not answering.
 */
export const REMOTE_UNANSWERED_READ_LIMIT = 2

/**
 * How long after its last tool a controller re-reads the other machine's
 * repository. The same read on the machine that owns the task is debounced too:
 * a checkout that keeps moving is read when it stops moving.
 */
export const REMOTE_REPOSITORY_SETTLE_MS = 1_200

/**
 * How many pages of events one catch-up walks before it takes a snapshot
 * instead. Each page is bounded by the transport, so this is what keeps a
 * recovery from turning into a slow replay of the task's whole history.
 */
export const REMOTE_CATCH_UP_ROUNDS = 3

const uid = () => crypto.randomUUID()

/** What one message may carry, which is what the other machine accepts in a batch. */
export const REMOTE_ATTACH_LIMIT = 8

export type UiLanguage = 'zh' | 'en'
export type NotifyInput = { tone: 'success' | 'error' | 'info'; title: string; message?: string }

/**
 * The newest few drafts, by conversation.
 *
 * A window is not a filing cabinet: what somebody is still writing is worth
 * keeping when they look away, and a conversation they have not touched in a
 * dozen others is one they will retype rather than come back to.
 */
function keepRecentBuckets<T>(buckets: Record<string, T>, limit = 12) {
  const keys = Object.keys(buckets);
  if (keys.length <= limit) return buckets
  const kept = { ...buckets };
  for (const stale of keys.slice(0, keys.length - limit)) delete kept[stale];
  return kept;
}

/**
 * A file waiting in the composer, on its way to the machine that will read it.
 *
 * It is in the composer from the moment it was pasted, dropped, or picked — the
 * way a local attachment is — because a file that appears only after a round trip
 * reads as a paste that did nothing. `key` is this window's own handle on the
 * entry, which is what the list is keyed by, so what the peer answers lands on
 * the card that is already on screen; `id` is empty until the bytes are there.
 */
export type RemotePendingAttachment = {
  key: string
  id: string
  desktopId: string
  /** The peer's task the file belongs to, known once there is one to put it in. */
  taskId: string
  name: string
  kind: RemoteAttachment['kind']
  size: number
  /**
   * The bytes of a picture this window is holding, for as long as the card is on
   * screen: it is shown from here rather than after the round trip that would
   * hand the same bytes back.
   */
  preview?: File
}

/** One file this window has in hand, named and shaped before it leaves. */
type IncomingAttachment = { name: string; kind: RemoteAttachment['kind']; size: number; path?: string; file?: File }

const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif']
const attachmentKinds: Array<[RemoteAttachment['kind'], string[]]> = [
  ['document', ['doc', 'docx', 'rtf', 'odt', 'pages']],
  ['spreadsheet', ['xls', 'xlsx', 'csv', 'tsv', 'numbers']],
  ['presentation', ['ppt', 'pptx', 'key']],
  ['text', ['txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'log', 'ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'css', 'html', 'xml', 'toml', 'sql']],
  ['archive', ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']],
  ['media', ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm']],
]

/**
 * What a file is, before the other machine has read its bytes.
 *
 * The peer classifies the file itself and its own answer replaces this guess; it
 * exists so the card a person is looking at while the file is in flight has the
 * right shape and the right word on it.
 */
export function attachmentKindOf(name: string, mimeType = ''): RemoteAttachment['kind'] {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType === 'application/pdf') return 'pdf'
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (imageExtensions.includes(extension)) return 'image'
  if (extension === 'pdf') return 'pdf'
  for (const [kind, extensions] of attachmentKinds) if (extensions.includes(extension)) return kind
  return 'unknown'
}

const attachmentName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || 'Attachment'

/**
 * A file belonging to this window, ready to be named and shown before it leaves.
 *
 * A file that exists on this disk travels as its path, so the process that owns
 * it reads it and its bytes never cross the renderer; a file that exists only in
 * memory — a screenshot on the clipboard — travels as bytes.
 */
function describeIncoming(file: File, index: number, stamp: string): IncomingAttachment {
  const name = file.name || `Screenshot-${stamp}${index ? `-${index + 1}` : ''}.${file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'}`,
    kind = attachmentKindOf(name, file.type);
  let path = '';
  try {
    path = window.shun.pathForFile(file);
  } catch {
    // A file with no place on this disk is still a file: it travels as bytes.
    path = '';
  }
  return { name, kind, size: file.size, ...(path ? { path } : { file }) };
}

function describeChosenPath(path: string): IncomingAttachment {
  const name = attachmentName(path);
  return { name, kind: attachmentKindOf(name), size: 0, path };
}

/**
 * One view the other machine's packages offer.
 *
 * It is that machine's own descriptor cut down to what travels. How a view is
 * offered is the package's rule — its rail, its workspace need, who may ask for
 * it — so the fields that rule reads travel with it instead of being guessed
 * here, which is what lets a controller draw the same rail the other machine
 * draws rather than a second opinion about it.
 */
export type RemotePluginViewSummary = {
  pluginId: string
  viewId: string
  title: string
  location?: PluginViewLocation
  entry?: string
  icon?: PluginManifest['icon']
  iconUrl?: string
  localEndpoints?: boolean
  /**
   * Whether that machine's own rail is showing this view right now.
   *
   * Which views a rail shows is a fact about that window — what this person has
   * opened there, and where — and not a fact about the package. Absent from a
   * machine too old to answer it.
   */
  inRail?: boolean
  // How a view is offered is the manifest's own rule, and a machine older than
  // this one does not send it: absent means the view is not offered in a rail
  // here, rather than a crash in the rule that reads it.
  launch?: PluginViewLaunchSource[]
  rail?: PluginViewRailPolicy
  workspace?: PluginWorkspaceRequirement
  permissions?: string[]
}

/** What that machine answers when a view is opened, before this one serves it. */
type RemoteOpenedPluginView = {
  pluginId?: string
  viewId?: string
  title?: string
  url?: string
  entry?: string
  accessToken?: string
  boundWorkspace?: string
  boundTaskId?: string
  workspaceRoot?: string
  permissions?: string[]
  localEndpoints?: boolean
}

/** One of the other machine's views, open here. */
export type OpenRemotePluginView = {
  desktopId: string
  taskId: string
  /** The address on this machine the package's own interface is served at. */
  frameUrl: string
  sessionId: string
  /** What the host draws its chrome from, and what a call out of the view is authorized by. */
  view: PluginViewContribution
}

/**
 * The name a view is reached by again.
 *
 * It is the same name on every open, because that is what makes the second open
 * cheap: the tunnel this machine answers caches under it, so coming back to a
 * view it has already served costs a revalidation rather than the interface.
 */
export function pluginPreviewKey(pluginId: string, viewId: string) {
  return `p-${pluginId}-${viewId}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
}

/**
 * The chrome an opened view is drawn with, built from the answer rather than
 * from a list this machine happens to have read: a view a conversation asked for
 * is opened even when no list mentioned it.
 */
function remotePluginContribution(opened: RemoteOpenedPluginView, summary: RemotePluginViewSummary | undefined, taskId: string): PluginViewContribution {
  const pluginId = String(opened.pluginId || summary?.pluginId || ''), viewId = String(opened.viewId || summary?.viewId || '');
  return {
    pluginId,
    viewId,
    title: String(opened.title || summary?.title || viewId),
    location: summary?.location || 'workspace.right',
    url: String(opened.url || ''),
    icon: summary?.icon || 'plugin',
    ...(summary?.iconUrl ? { iconUrl: summary.iconUrl } : {}),
    // The permissions are the ones the other machine granted this open, not the
    // ones the descriptor lists: what a view may do is what it was authorized for.
    permissions: opened.permissions || summary?.permissions || [],
    workspace: summary?.workspace || 'optional',
    rail: summary?.rail || 'on-demand',
    launch: summary?.launch || ['user', 'assistant'],
    ...(opened.localEndpoints || summary?.localEndpoints ? { activation: { localEndpoints: true } } : {}),
    accessToken: String(opened.accessToken || ''),
    boundWorkspace: String(opened.boundWorkspace || ''),
    boundTaskId: String(opened.boundTaskId || taskId),
    // Where the view's own reads resolve. The interface is told a directory, and
    // the directory it must be told is the one the other machine resolves — a
    // view told a path that does not exist where it runs concludes it cannot work.
    workspaceRoot: String(opened.workspaceRoot || opened.boundWorkspace || ''),
  };
}

/**
 * Everything a Remote link needs while someone is looking at it: the paired
 * machines, the task list of the one being driven, the conversation being
 * watched, and the commands that act on it.
 *
 * It is a hook and not a page because Remote is a mode of the app's own surface
 * — the sidebar lists its tasks, the feed draws its turns, the composer sends to
 * it — so the state has to live where those pieces can all reach it.
 */
/**
 * The last few conversations this window read, by task.
 *
 * Switching tasks asked the peer for a snapshot and drew nothing until it came
 * back, so going back to a conversation that had just been on screen cost the
 * same round trip as opening it for the first time. What was read is kept, and
 * the snapshot that follows the switch is the refresh rather than the first paint.
 */
const VIEW_CACHE_LIMIT = 4
const viewCache = new Map<string, RemoteTaskView>()

function viewCacheKey(desktopId: string, taskId: string) {
  return `${desktopId}:${taskId}`
}

function readViewCache(desktopId: string, taskId: string) {
  const key = viewCacheKey(desktopId, taskId)
  const cached = viewCache.get(key)
  // Reading it makes it the most recent one: what somebody returns to is what
  // they were in, not what they happened to open first.
  if (cached) { viewCache.delete(key); viewCache.set(key, cached) }
  return cached
}

function writeViewCache(desktopId: string, view: RemoteTaskView) {
  if (!view.ready) return
  const key = viewCacheKey(desktopId, view.taskId)
  viewCache.delete(key)
  viewCache.set(key, view)
  while (viewCache.size > VIEW_CACHE_LIMIT) viewCache.delete(viewCache.keys().next().value as string)
}

export function useRemoteSession({ language, notify }: { language: UiLanguage; notify: (input: NotifyInput) => string }) {
  const zh = language === "zh";
  const message = (error: unknown) => remoteFailureText(error);
  const [desktops, setDesktops] = useState<RemoteDesktopState[]>([]);
  // The other direction: the devices paired *to* this machine.
  const [pairedDevices, setPairedDevices] = useState<RemoteDeviceState[]>([]);
  const [activeId, setActiveId] = useState("");
  const [tasks, setTasks] = useState<Record<string, RemoteTaskSummary[]>>({});
  const [tasksLoading, setTasksLoading] = useState(false);
  const [open, setOpen] = useState<{ desktopId: string; taskId: string } | null>(null);
  const [view, setView] = useState<RemoteTaskView | null>(null);
  /**
   * What is written but not sent, per conversation on the other machine.
   *
   * A draft belongs to the conversation it was written for. One box for the whole
   * window took it away the moment somebody looked at another conversation, and it
   * carried one task's files into another — where the machine that owns them, which
   * checks every attachment against the task it was uploaded into, answered "one or
   * more attachments are unavailable".
   */
  const [draftsByTask, setDraftsByTask] = useState<Record<string, string>>({});
  const [pendingByTask, setPendingByTask] = useState<Record<string, RemotePendingAttachment[]>>({});
  /** The message this person just sent, so the feed can land on it. */
  const [sentTurnId, setSentTurnId] = useState("");
  const [remoteModels, setRemoteModels] = useState<{ selected: string; models: Array<{ id: string; name?: string; contextWindow?: number; maxOutputTokens?: number }> }>({ selected: "", models: [] });
  const [modelMenu, setModelMenu] = useState(false);
  const [sending, setSending] = useState(false);
  const [expandedTool, setExpandedTool] = useState("");
  const [showPair, setShowPair] = useState(false);
  const [pairCode, setPairCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState("");
  const [panel, setPanel] = useState<"none" | "changes" | "resources" | "files">("none");
  const [records, setRecords] = useState<Record<string, RemoteToolRecord | null>>({});
  const [changes, setChanges] = useState<RemoteChangesState | null>(null);
  /**
   * The repository the open task is in, on the machine that owns it.
   *
   * The header draws one branch chip on both sides of a link, and the branch it
   * has to name is the one that task is being worked on in — which is that
   * machine's checkout. A window that drew its own local branch there named a
   * different project entirely: the header belongs to the task, not to this Mac.
   */
  const [repository, setRepository] = useState<{ branch: string; changes: number } | null>(null);
  const [resources, setResources] = useState<RemoteResource[] | null>(null);
  const [workspace, setWorkspace] = useState("");
  /** The Skills the peer lets this conversation name, and the one the next message carries. */
  const [peerSkills, setPeerSkills] = useState<Array<{ id: string; name: string; description: string }>>([]);
  const [selectedSkill, setSelectedSkill] = useState<{ id: string; name: string } | null>(null);
  const [browsing, setBrowsing] = useState<RemoteWorkspaceDirectory | null>(null);
  const [files, setFiles] = useState<WorkspaceDirectoryListing | null>(null);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [terminal, setTerminal] = useState(false);
  /** The other machine's views, which is what its rail is drawn from. */
  const [pluginViews, setPluginViews] = useState<RemotePluginViewSummary[]>([]);
  const [pluginView, setPluginView] = useState<OpenRemotePluginView | null>(null);
  /**
   * The view a click asked for, before it is here.
   *
   * Opening one is a round trip for the address and then the package's own files
   * over the link, and until then there was nothing at all on screen: the click
   * read as one that did nothing. What travels back is the panel's title and its
   * icon, which is enough to draw the panel it will become.
   */
  const [pluginViewOpening, setPluginViewOpening] = useState<{ pluginId: string; viewId: string; title: string; icon?: string; iconUrl?: string } | null>(null);
  const [expandedChange, setExpandedChange] = useState("");
  const openRef = useRef(open);
  const viewRef = useRef(view);
  const pluginViewRef = useRef(pluginView);
  const pluginViewsRef = useRef(pluginViews);
  /**
   * The view requests this window has already answered, by tool call.
   *
   * A remote conversation is re-read as it streams, so the same call is seen
   * again and again — and a view that is opened again on every batch is a view
   * that never finishes opening.
   */
  const answeredPluginViews = useRef(new Set<string>());
  const tasksRef = useRef(tasks);
  const desktopsRef = useRef(desktops);
  const draftRef = useRef("");
  const pendingRef = useRef<RemotePendingAttachment[]>([]);
  /** The upload in flight, which a message naming one of its files has to wait for. */
  const attaching = useRef<Promise<void> | null>(null);
  const buffered = useRef<RemoteEvent[]>([]);
  /** Consecutive reads that went unanswered while this view said a run is going. */
  const unansweredReads = useRef(0);
  /**
   * The task this window created in order to attach a file to a draft.
   *
   * It bridges one render: the id is known the moment the peer answers, while
   * the view that shows it arrives a moment later.
   */
  const attachmentTask = useRef<{ desktopId: string; taskId: string }>({ desktopId: "", taskId: "" });
  const openToken = useRef(0);
  /**
   * A send is one gesture, and a second press inside it is the same gesture.
   *
   * The sending flag is a render behind, so two presses in one moment both passed
   * it: the second asked the other machine to start a run it had just been asked to
   * start, and the refusal that came back was about a message that was already on
   * its way.
   */
  const sendingRef = useRef(false);
  openRef.current = open;
  viewRef.current = view;
  pluginViewRef.current = pluginView;
  pluginViewsRef.current = pluginViews;
  tasksRef.current = tasks;
  desktopsRef.current = desktops;

  const active = desktops.find((item) => item.id === activeId) || desktops[0];
  /**
   * Which conversation this composer is writing for: the open task, or the task
   * that would be created for a draft nobody has sent yet.
   */
  const draftKey = open ? `${open.desktopId}:${open.taskId}` : active?.id ? `${active.id}:new` : "";
  const draft = draftsByTask[draftKey] || "";
  const pendingAttachments = pendingByTask[draftKey] || [];
  /** One bucket per conversation, and only the ones somebody is still writing in. */
  function writeDraft(update: string | ((current: string) => string)) {
    setDraftsByTask((all) => keepRecentBuckets({ ...all, [draftKey]: typeof update === "function" ? update(all[draftKey] || "") : update }));
  }
  function writePendingFor(key: string, update: RemotePendingAttachment[] | ((current: RemotePendingAttachment[]) => RemotePendingAttachment[])) {
    setPendingByTask((all) => keepRecentBuckets({ ...all, [key]: typeof update === "function" ? update(all[key] || []) : update }));
  }
  const setDraft = writeDraft;
  const setPendingAttachments = (update: RemotePendingAttachment[] | ((current: RemotePendingAttachment[]) => RemotePendingAttachment[])) => writePendingFor(draftKey, update);
  draftRef.current = draft;
  pendingRef.current = pendingAttachments;
  const activeTasks = active ? tasks[active.id] || [] : [];  const openDesktop = open ? desktops.find((item) => item.id === open.desktopId) : undefined;
  const running = view?.status === "running";
  /** The peer is compacting: a message sent now would be refused there. */
  const compacting = Boolean(view?.compacting);
  /** The last thing the peer ran, which is when its checkout can have moved. */
  const lastSettledToolId = newestSettledToolId(view);
  /**
   * A new task usually continues the project someone was just working in, so the
   * first read of the peer's tasks fills the draft in — once, and never over a
   * choice the person made themselves.
   */
  const inheritedWorkspace = useRef(false);
  useEffect(() => {
    if (inheritedWorkspace.current || workspace || !active?.id) return;
    const recent = (tasks[active.id] || []).find((item) => item.workspace);
    if (!recent) return;
    inheritedWorkspace.current = true;
    setWorkspace(recent.workspace);
  }, [active?.id, tasks, workspace]);

  async function refreshPairedDevices() {
    try {
      setPairedDevices(await window.shun.remoteDevices());
    } catch {
      // A relay that is not ready yet reports nothing rather than an error the
      // person cannot act on; the next refresh asks again.
    }
  }

  /** Let one of the machines paired to this one go. */
  async function forgetDevice(id: string, name: string) {
    const done = await window.shun.forgetRemoteDevice(id).catch(() => false);
    if (!done) return false;
    await refreshPairedDevices();
    notify({ tone: "success", title: language === "zh" ? "已断开配对" : "Unpaired", message: name });
    return true;
  }

  async function refreshDesktops() {
    const list = await window.shun.remoteDesktops();
    setDesktops(list);
    setActiveId((current) => current && list.some((item) => item.id === current) ? current : list[0]?.id || "");
    return list;
  }

  async function loadTasks(desktopId: string, quiet = false) {
    if (!desktopId) return;
    if (!quiet) setTasksLoading(true);
    try {
      const list = await window.shun.requestRemoteDesktop(desktopId, "tasks.list");
      setTasks((current) => ({ ...current, [desktopId]: Array.isArray(list) ? list as RemoteTaskSummary[] : [] }));
    } catch (error) {
      if (!quiet) notify({ tone: "error", title: zh ? "无法读取远端任务" : "Could not read remote tasks", message: message(error) });
    } finally {
      if (!quiet) setTasksLoading(false);
    }
  }

  /**
   * Say which task this window is looking at.
   *
   * A run streams a delta frame every display tick, and the peer sends those to
   * a controller whether or not it is showing the task they belong to. Naming
   * the one on screen is what lets the peer stop streaming the rest: the
   * conversation being watched is unchanged, and the ones nobody opened cost no
   * frames. Everything that moves a row — a start, a finish, a rename — keeps
   * arriving either way, so the list is exactly as live as it was.
   *
   * The declaration is the link's, not this window's: it is made again on every
   * connection by the side that holds the socket, and a peer that is never told
   * keeps sending everything, which is what the phone client relies on until it
   * says the same thing.
   */
  function declareWatch(desktopId: string, taskIds: string[]) {
    if (!desktopId) return;
    void window.shun.watchRemoteDesktopTasks(desktopId, taskIds).catch(() => {
      // A declaration that did not land is made again when the link reconnects,
      // and until then the peer sends more rather than less.
    });
  }

  /**
   * Catch up incrementally; a gap the peer can no longer fill, or a backlog too
   * long to walk, costs a snapshot.
   *
   * What was fetched is applied to the view *as it is now*, never to the copy
   * this started from: events arrive while a catch-up is in flight, and writing
   * the older copy back moves the sequence backwards — the view then meets every
   * event after it a second time and replays history it had already shown. The
   * sequence check is what makes applying it again safe, since anything already
   * applied is dropped.
   *
   * A backlog that does not close within its rounds takes a snapshot instead of
   * another page: stepping a long history in pages is the same replay, only
   * slower, and the snapshot lands on the newest state in one answer.
   */
  async function resync(target: { desktopId: string; taskId: string }) {
    const start = viewRef.current;
    if (!start || start.taskId !== target.taskId) return;
    let cursor = start.latestSeq, continues = true, more = false;
    const fetched: RemoteEvent[] = [];
    for (let round = 0; round < REMOTE_CATCH_UP_ROUNDS && continues; round += 1) {
      let page: { events: RemoteEvent[]; hasMore?: boolean };
      try {
        page = await window.shun.requestRemoteDesktop(target.desktopId, "task.events", { taskId: target.taskId, afterSeq: cursor }) as { events: RemoteEvent[]; hasMore?: boolean };
      } catch {
        continues = false;
        break;
      }
      const events = Array.isArray(page.events) ? page.events : [];
      if (!events.length) break;
      // A page that starts after the next event this view can take cannot close
      // the gap: the events in between are no longer on the execution node.
      if (!catchUpContinues(cursor, events)) { continues = false; break }
      fetched.push(...events);
      cursor = Math.max(cursor, events[events.length - 1].seq);
      more = Boolean(page.hasMore);
      if (!more) break;
    }
    const current = viewRef.current;
    if (!current || current.taskId !== target.taskId) return;
    if (continues && !more) {
      setView({ ...applyRemoteEvents(current, fetched), needsResync: false });
      return;
    }
    try {
      const snapshot = await window.shun.requestRemoteDesktop(target.desktopId, "task.snapshot", { taskId: target.taskId, turnLimit: 40 }) as RemoteSnapshot;
      const latest = viewRef.current;
      if (latest && latest.taskId === target.taskId) setView(applyRemoteSnapshot(latest, snapshot));
    } catch {
      // A link that is down is already reported, and the next tick tries again.
    }
  }

  function applyBatch(batch: RemoteDesktopEventBatch) {
    const target = openRef.current;
    if (!target || target.desktopId !== batch.desktopId) return;
    // A batch can carry another task's progress (a title, a run that started):
    // the list follows along even when the open conversation is the busy one.
    // A delta is not progress in that sense — it is text arriving in a
    // conversation nobody is reading — and asking for the whole list on every
    // one of them was the list read back to back for the length of a run.
    if (batch.events.some((event) => event.taskId !== target.taskId && event.type !== "turn.delta")) void loadTasks(batch.desktopId, true);
    if (batch.staleTasks.includes(target.taskId)) {
      void resync(target);
      return;
    }
    const events = batch.events.filter((event) => event.taskId === target.taskId) as RemoteEvent[];
    if (!events.length) return;
    const current = viewRef.current;
    if (!current?.ready) {
      buffered.current.push(...events);
      return;
    }
    const next = applyRemoteEvents(current, events);
    setView(next);
    // A view that skipped a sequence refuses everything after it, so the events
    // it is missing are what it needs — not a listener that waits for someone
    // else to notice. Without this the conversation stops on whatever the
    // snapshot said, however long the run keeps going.
    if (next.needsResync) void resync(target);
    // The list follows the run: start and finish are what change a row's state.
    if (events.some((event) => event.type === "run.started" || event.type === "run.finished" || event.type === "task.patch")) {
      void loadTasks(target.desktopId, true);
    }
  }

  async function openTask(desktopId: string, taskId: string) {
    const token = ++openToken.current;
    attachmentTask.current = { desktopId, taskId };
    // A view belongs to the conversation it was opened from: the next task opens
    // with none, rather than with the last one's interface still on screen.
    if (pluginViewRef.current && (pluginViewRef.current.desktopId !== desktopId || pluginViewRef.current.taskId !== taskId)) closePluginView();
    setOpen({ desktopId, taskId });
    // The peer is told before the conversation lands, so the events that arrive
    // while the snapshot is in flight are delivered rather than filtered.
    declareWatch(desktopId, [taskId]);
    // A conversation this window has already read opens on what it read: it is on
    // screen in the same frame as the click, and the snapshot below is the refresh
    // rather than the first paint. Nothing is drawn from a stale row either — the
    // snapshot replaces what it is missing, and a gap in the events asks for the
    // events.
    setView(readViewCache(desktopId, taskId) || emptyRemoteTaskView(taskId));
    setExpandedTool("");
    setExpandedChange("");
    // A record or a change list belongs to the task it came from.
    setRecords({});
    setChanges(null);
    setRepository(null);    setResources(null);
    buffered.current = [];
    unansweredReads.current = 0;
    try {
      const snapshot = await window.shun.requestRemoteDesktop(desktopId, "task.snapshot", { taskId, turnLimit: 40 }) as RemoteSnapshot;
      if (token !== openToken.current) return;
      const queued = buffered.current;
      buffered.current = [];
      setView(applyRemoteEvents(applyRemoteSnapshot(emptyRemoteTaskView(taskId), snapshot), queued));
      void loadModels();
      void loadPluginViews();
      void loadRepository();
      if (panel === "changes") void loadChanges();
      if (panel === "resources") void loadResources();
    } catch (error) {
      if (token !== openToken.current) return;
      // The task never opened, so nothing here is being watched any more.
      declareWatch(desktopId, []);
      setOpen(null);
      setView(null);
      notify({ tone: "error", title: zh ? "打不开远端任务" : "Could not open the remote task", message: message(error) });
    }
  }

  async function command(kind: string, payload: Record<string, unknown>, onError?: string) {
    const failure = await askCommand(kind, payload);
    if (!failure) return true;
    notify({ tone: "error", title: onError || (zh ? "远端命令失败" : "The remote command failed"), message: failure });
    return false;
  }

  /**
   * The same call as `command`, answered with what went wrong instead of said out
   * loud. One gesture that may take two roads says its failure once, at the end,
   * and only if the second road failed as well.
   */
  async function askCommand(kind: string, payload: Record<string, unknown>) {
    const target = openRef.current;
    if (!target) return zh ? "这条链接已经不在了。" : "This link is no longer open.";
    try {
      await window.shun.requestRemoteDesktop(target.desktopId, kind, payload);
      return "";
    } catch (error) {
      return message(error);
    }
  }

  /**
   * Whether the other machine says this task is running, asked when its refusal and
   * this window's reading disagree.
   *
   * A message may only be queued there on the fact, never on the copy this window
   * holds: that copy is the thing that chose the wrong road. A link that cannot
   * answer is not evidence that the task is free, so the message goes back to the
   * person rather than into a queue nobody confirmed.
   */
  async function peerIsRunning(target: { desktopId: string; taskId: string }) {
    try {
      const snapshot = await window.shun.requestRemoteDesktop(target.desktopId, "task.snapshot", { taskId: target.taskId, turnLimit: 1 }) as RemoteSnapshot;
      return snapshot.status === "running";
    } catch {
      return false;
    }
  }

  /**
   * One tool row, asked for on a click. The streamed row is bounded on purpose,
   * so this is where the arguments, the whole output, and the diff arrive — and
   * where a failure leaves the bounded preview in place rather than an error.
   */
  async function loadToolRecord(toolId: string) {
    const target = openRef.current;
    if (!target || toolId in records) return;
    setRecords((current) => ({ ...current, [toolId]: null }));
    try {
      const record = await window.shun.requestRemoteDesktop(target.desktopId, "task.tool", { taskId: target.taskId, toolId });
      setRecords((current) => ({ ...current, [toolId]: record as RemoteToolRecord }));
    } catch {
      setRecords((current) => ({ ...current, [toolId]: null }));
    }
  }

  /**
   * Which branch the open task is on, over there, and how much it has moved.
   *
   * One small read, on open and when a run settles — which is when a task's
   * checkout actually changes — so the header never has to borrow this window's
   * own repository to fill a chip about somebody else's task.
   */
  async function loadRepository() {
    const target = openRef.current;
    if (!target) { setRepository(null); return; }
    try {
      const snapshot = await window.shun.requestRemoteDesktop(target.desktopId, "repository.snapshot", { taskId: target.taskId }) as { branch?: unknown; entries?: unknown };
      if (openRef.current?.taskId !== target.taskId) return;
      setRepository({ branch: String(snapshot?.branch || ""), changes: Array.isArray(snapshot?.entries) ? snapshot.entries.length : 0 });
    } catch {
      setRepository(null);
    }
  }

  async function loadChanges() {
    const target = openRef.current;
    if (!target) return;
    setChanges({ branch: "", entries: [], hunks: [], loading: true, error: "" });
    try {
      const [snapshot, diff] = await Promise.all([
        window.shun.requestRemoteDesktop(target.desktopId, "repository.snapshot", { taskId: target.taskId }),
        window.shun.requestRemoteDesktop(target.desktopId, "repository.diff", { taskId: target.taskId }),
      ]);
      if (viewRef.current?.taskId !== target.taskId) return;
      setChanges({
        branch: String((snapshot as { branch?: string })?.branch || ""),
        entries: Array.isArray((snapshot as { entries?: RemoteChangeEntry[] })?.entries) ? (snapshot as { entries: RemoteChangeEntry[] }).entries : [],
        hunks: Array.isArray(diff) ? diff as RemoteDiffEntry[] : [],
        loading: false,
        error: "",
      });
    } catch (error) {
      setChanges({ branch: "", entries: [], hunks: [], loading: false, error: message(error) });
    }
  }

  /**
   * The task a draft becomes on the other machine.
   *
   * A file belongs to the task it is attached to and a view reads the task it is
   * opened for, and both of those tasks live over there — so a draft that is
   * about to carry either creates that task first, the way the phone creates one
   * before its first message. The choice of project travels with the creation,
   * exactly as the draft shows it, and what was written for the task moves into
   * it, so the box the person is looking at is still the box they were writing in.
   */
  async function draftTask(): Promise<{ desktopId: string; taskId: string; workspace: string } | undefined> {
    const desktopId = active?.id;
    if (!desktopId) return undefined;
    const current = openRef.current;
    if (current) return { ...current, workspace: viewRef.current?.workspace || "" };
    const remembered = attachmentTask.current;
    if (remembered.desktopId === desktopId && remembered.taskId) return { ...remembered, workspace };
    try {
      const created = await window.shun.requestRemoteDesktop(desktopId, "task.create", { workspace }) as { id?: string };
      if (!created?.id) throw Error(zh ? "那台机器没有建出任务" : "The other machine did not create the task.");
      attachmentTask.current = { desktopId, taskId: created.id };
      await loadTasks(desktopId, true);
      const from = `${desktopId}:new`, to = `${desktopId}:${created.id}`;
      setDraftsByTask((all) => (all[from] ? { ...all, [to]: all[from], [from]: "" } : all));
      void openTask(desktopId, created.id);
      return { desktopId, taskId: created.id, workspace };
    } catch (error) {
      notify({ tone: "error", title: zh ? "无法在那台机器上新建任务" : "Could not start a task on the other machine", message: message(error) });
      return undefined;
    }
  }

  /**
   * Files the person picked, and files this window already had in hand.
   *
   * They take one road: each is in the composer before anything is asked of the
   * other machine, and one file goes at a time, so a refusal names the file that
   * was refused and leaves the ones already there where they are.
   */
  async function sendFiles(incoming: IncomingAttachment[]) {
    if (!incoming.length) return;
    const desktopId = active?.id;
    if (!desktopId) return;
    const from = draftKey;
    const waiting: RemotePendingAttachment[] = incoming.map((item) => ({
      key: uid(),
      id: "",
      desktopId,
      taskId: "",
      name: item.name,
      kind: item.kind,
      size: item.size,
      ...(item.file && item.kind === "image" ? { preview: item.file } : {}),
    }));
    writePendingFor(from, (current) => [...current, ...waiting]);
    // A draft has no task yet, and an attachment lives in the task it belongs to:
    // that task is created on the other machine before the first byte is sent —
    // and what was written for it moves with it, so the box the person is looking
    // at is still the box they were writing in.
    const target = await draftTask();
    if (!target) {
      writePendingFor(from, (current) => current.filter((item) => !waiting.some((entry) => entry.key === item.key)));
      return;
    }
    const to = `${target.desktopId}:${target.taskId}`;
    if (to !== from) {
      writePendingFor(from, (current) => current.filter((item) => !waiting.some((entry) => entry.key === item.key)));
      writePendingFor(to, (current) => [...current, ...waiting.map((item) => ({ ...item, desktopId: target.desktopId, taskId: target.taskId }))]);
      setDraftsByTask((all) => (all[from] ? { ...all, [to]: all[from], [from]: "" } : all));
    }
    // The task is the entry's own fact even when the draft did not move: a file
    // attached while writing in a task the machine already has stays in the box it
    // was written in, and was left naming no task at all — which is the id the
    // viewer sends over the link, so opening that picture asked the other machine
    // for an attachment of nothing.
    writePendingFor(to, (current) => current.map((entry) => waiting.some((item) => item.key === entry.key)
      ? { ...entry, desktopId: target.desktopId, taskId: target.taskId }
      : entry));
    try {
      for (const [index, item] of incoming.entries()) {
        const key = waiting[index]!.key;
        const uploaded = item.path
          ? await window.shun.attachRemoteFilePaths(target.desktopId, target.taskId, [item.path])
          : await window.shun.attachRemoteFileData(target.desktopId, target.taskId, [{ name: item.name, data: await item.file!.arrayBuffer() }]);
        const ready = uploaded[0];
        if (!ready?.id) throw Error(zh ? "那台机器没有接下这个文件" : "The other machine did not take the file.");
        writePendingFor(to, (current) => current.map((entry) => entry.key === key ? {
          ...entry,
          id: ready.id,
          name: ready.name || entry.name,
          kind: (ready.kind as RemoteAttachment['kind']) || entry.kind,
          size: ready.size || entry.size,
        } : entry));
      }
    } catch (error) {
      // What is there stays where it is; what never left is not left looking as
      // though the other machine had it.
      writePendingFor(to, (current) => current.filter((item) => item.id || !waiting.some((entry) => entry.key === item.key)));
      notify({ tone: "error", title: zh ? "文件没有传到那台机器" : "The file did not reach the other machine", message: message(error) });
    }
  }

  /** The upload a message naming one of its files has to wait for. */
  function trackAttaching(work: Promise<void>) {
    attaching.current = work;
    return work.finally(() => {
      if (attaching.current === work) attaching.current = null;
    });
  }

  /** Send files to the machine that will read them, and keep them until the message goes. */
  async function attachFiles() {
    try {
      const chosen = await window.shun.chooseRemoteFiles() as string[];
      if (!Array.isArray(chosen) || !chosen.length) return;
      await trackAttaching(sendFiles(chosen.slice(0, REMOTE_ATTACH_LIMIT).map(describeChosenPath)));
    } catch (error) {
      notify({ tone: "error", title: zh ? "无法选择文件" : "Could not choose files", message: message(error) });
    }
  }

  /**
   * Files this window already has in hand, pasted or dropped.
   *
   * The clipboard is only readable while the event is dispatching, so everything
   * a file needs is taken from it here, before the first await: a file that
   * exists on this disk travels as its path, and one that exists only in memory
   * travels as bytes, both named and shaped before either has left.
   */
  function attachFilesFrom(files: File[]) {
    if (!files.length || !active?.id) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    void trackAttaching(sendFiles(files.slice(0, REMOTE_ATTACH_LIMIT).map((file, index) => describeIncoming(file, index, stamp))));
  }

  function toggleModelMenu() {
    setModelMenu((current) => !current);
  }

  /** The person's own choice of project, which an inherited default never replaces. */
  function chooseWorkspace(path: string) {
    inheritedWorkspace.current = true;
    setWorkspace(path);
  }

  /** The model list belongs to the machine that runs the task, not to this one. */
  async function loadModels() {
    const target = openRef.current;
    if (!target) return;
    try {
      const list = await window.shun.requestRemoteDesktop(target.desktopId, "models.list") as { selected?: string; models?: Array<{ id: string; name?: string; contextWindow?: number; maxOutputTokens?: number }> };
      setRemoteModels({ selected: String(list?.selected || ""), models: Array.isArray(list?.models) ? list.models : [] });
    } catch {
      setRemoteModels({ selected: "", models: [] });
    }
  }

  async function selectModel(model: string) {
    const target = openRef.current;
    if (!target) return;
    if (await command("task.model", { taskId: target.taskId, model })) {
      setModelMenu(false);
      setRemoteModels((current) => ({ ...current, selected: model }));
      void loadTasks(target.desktopId, true);
    }
  }

  async function loadFiles(path?: string, hidden = includeHidden) {
    const target = openRef.current;
    if (!target) return;
    try {
      const listing = await window.shun.requestRemoteDesktop(target.desktopId, "files.browse", { taskId: target.taskId, ...(path ? { path } : {}), includeHidden: hidden }) as WorkspaceDirectoryListing;
      if (viewRef.current?.taskId !== target.taskId) return;
      setFiles(listing);
    } catch (error) {
      notify({ tone: "error", title: zh ? "无法浏览远端工作区" : "Could not browse the remote workspace", message: message(error) });
    }
  }

  async function loadResources() {
    const target = openRef.current;
    if (!target) return;
    setResources(null);
    try {
      const result = await window.shun.requestRemoteDesktop(target.desktopId, "resources.list", { taskId: target.taskId }) as { processes?: RemoteResource[] };
      setResources(Array.isArray(result?.processes) ? result.processes : []);
    } catch (error) {
      setResources([]);
      notify({ tone: "error", title: zh ? "无法读取远端进程" : "Could not read remote processes", message: message(error) });
    }
  }

  /** Pull one file off the peer and write it where the person chose. */
  async function saveFile(path: string) {
    const target = openRef.current;
    if (!target) return undefined;
    return window.shun.saveRemoteFile(target.desktopId, target.taskId, path);
  }

  async function browseWorkspace(path?: string) {
    const desktopId = active?.id;
    if (!desktopId) return;
    try {
      const directory = await window.shun.requestRemoteDesktop(desktopId, "workspaces.browse", path ? { path } : {}) as RemoteWorkspaceDirectory;
      setBrowsing(directory);
    } catch (error) {
      notify({ tone: "error", title: zh ? "无法浏览远端文件夹" : "Could not browse the other Shun", message: message(error) });
    }
  }

  /**
   * A message going to the other machine.
   *
   * `immediate` is the same gesture it is here — the modifier held while pressing
   * Enter — so a reply being written on the other machine is stopped for this
   * message instead of this one waiting behind it. A file that belongs to the
   * message waits for its bytes either way: the message names an attachment the
   * peer has not finished receiving otherwise, and the send spinner is what says
   * the wait is happening.
   */
  async function send(immediate = false) {
    const target = openRef.current;
    if (!target || sendingRef.current) return;
    // The machine that owns the task refuses a message while it is compacting, so
    // the message is not sent: what was written stays in the box, and the same
    // sentence the other machine would say is said here.
    if (viewRef.current?.compacting) {
      notify({
        tone: "info",
        title: zh ? "正在压缩上下文" : "Compacting context",
        message: zh ? "压缩完成后才能发送消息。" : "Messages can be sent once compaction finishes.",
      });
      return;
    }
    setSending(true);
    sendingRef.current = true;
    try {
      if (attaching.current) await attaching.current;
      const text = draftRef.current.trim(), pending = pendingRef.current;
      if (!text && !pending.length) return;
      const messageId = uid();
      const runId = uid();
      const attachments = pending.map((item) => ({ id: item.id, kind: item.kind, name: item.name }));
      const restored = pending;
      // A message written while the other machine is working is queued there, the
      // way it is queued here: the reply keeps being written and this goes out when
      // it is done. A run in progress was a reason to refuse the message instead,
      // which is not what this product does on either side of a link.
      const busy = viewRef.current?.status === "running"
          || (tasksRef.current[target.desktopId] || []).some((task) => task.id === target.taskId && task.status === "running"),
        waiting = busy && !immediate,
        // A Skill is chosen for the message it sits in front of, and it travels
        // with that message: the run this starts is the run one started on the
        // machine that holds the Skill. A refused message keeps it, because the
        // sentence it belongs to is still in the box.
        skill = selectedSkill;
      // The message is on its way the moment it is sent: it appears, the composer
      // empties, and the feed is told where to go. Waiting for the other machine
      // would put a round trip between pressing Enter and the sentence leaving the
      // box, which is exactly where a message looks unsent.
      setDraft("");
      setPendingAttachments([]);
      setSelectedSkill(null);
      // Both roads keep the same intent: the message somebody just wrote is where
      // the feed should land. A queued one has no turn yet — it waits in the
      // peer's queue — so the intent is armed here and spent when the turn it
      // names appears, which is the only moment there is anything to land on. A
      // message that waits and then starts reading from the bottom of the feed
      // arrives off screen, and the taller the message the further off it is.
      setSentTurnId(messageId);
      if (waiting) {
        // It is not a turn yet: it waits in the queue the other machine owns, and
        // that queue is what this view shows — so it goes there now, under the id
        // it was written with and marked as still on its way. The peer's own
        // snapshot confirms it the moment that queue really holds it.
        setView((current) => current ? { ...current, queue: [...current.queue, { id: messageId, taskId: target.taskId, text, attachments, pending: true }] } : current);
      } else {
        setView((current) => current ? appendOptimisticTurn(current, { messageId, text, attachments }) : current);
      }
      const payload = { taskId: target.taskId, text, messageId, runId, attachments: attachments.map((item) => ({ id: item.id })), ...(skill ? { skillId: skill.id } : {}) };
      const road = waiting ? "task.message.enqueue" : busy ? "task.message.interrupt" : "task.message.send";
      let failure = await askCommand(road, payload), queued = false;
      if (failure && road === "task.message.send" && await peerIsRunning(target)) {
        // The other machine refused to start a run because it is still finishing one: this
        // window's reading was behind its truth, and that reading is what chose the road. What
        // the gesture meant decides the road it takes instead — the modifier means the reply
        // stops for this message, a plain Enter means the message waits its turn — and the
        // queue is the one road that takes a message whether that machine is working or not.
        const fallback = immediate ? "task.message.interrupt" : "task.message.enqueue";
        failure = await askCommand(fallback, payload);
        queued = !failure && fallback === "task.message.enqueue";
      }
      if (queued) {
        // It took the road it should have taken. The row is not a turn yet — it waits in the
        // queue the other machine owns, which is what this view shows — so the turn it was
        // drawn as is taken back and the same message appears there, under the id it was
        // written with and marked as still on its way. The peer's own snapshot confirms it
        // the moment that queue really holds it.
        setView((current) => current
          ? { ...removeOptimisticTurn(current, messageId), queue: [...current.queue, { id: messageId, taskId: target.taskId, text, attachments, pending: true }] }
          : current);
      }
      if (failure) {
        notify({ tone: "error", title: zh ? "消息没有发出去" : "The message was not sent", message: failure });
        // A message the other machine refused goes back to the person who wrote
        // it — unless they have already started typing something else, and its
        // claim on the feed goes with it.
        setSentTurnId((current) => current === messageId ? "" : current);
        setView((current) => current
          ? (waiting ? { ...current, queue: current.queue.filter((item) => item.id !== messageId) } : removeOptimisticTurn(current, messageId))
          : current);
        setDraft((current) => current.trim() ? current : text);
        setPendingAttachments((current) => current.length ? current : restored);
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  /**
   * A queued message, acted on the way it is acted on here.
   *
   * The row goes the moment the person acts on it: the queue belongs to the
   * machine that owns the message, but waiting for that machine to say so would
   * put a round trip between the click and the row leaving, which is not what
   * happens to the same row on the other side of the link. The peer's own queue
   * is still the truth, and its next reading of it is what this view keeps.
   */
  function dropQueued(item: RemoteQueueItem, failure: string) {
    const target = openRef.current;
    if (!target) return;
    setView((current) => current ? { ...current, queue: current.queue.filter((entry) => entry.id !== item.id) } : current);
    void command("task.queue.remove", { taskId: target.taskId, queueItemId: item.id }, failure);
  }

  /** Stop the reply being written and send this one instead, which is what the other machine does with it. */
  function sendQueuedNow(item: RemoteQueueItem) {
    const target = openRef.current;
    if (!target) return;
    setView((current) => current ? { ...current, queue: current.queue.filter((entry) => entry.id !== item.id) } : current);
    void command("task.queue.sendNow", { taskId: target.taskId, queueItemId: item.id }, zh ? "无法立即发送这条消息" : "Could not send the queued message now");
  }

  function discardQueued(item: RemoteQueueItem) {
    dropQueued(item, zh ? "无法移除这条排队消息" : "Could not remove the queued message");
  }

  /**
   * Take a queued message back into the composer, which is what the machine that
   * owns it does with one: a follow-up waiting over there is edited in the box it
   * was written in, not in the queue it is waiting in.
   */
  function recallQueued(item: RemoteQueueItem) {
    const target = openRef.current;
    if (!target) return;
    setDraft(item.text);
    setPendingAttachments((item.attachments || []).map((attachment) => ({
      key: attachment.id,
      id: attachment.id,
      desktopId: target.desktopId,
      taskId: target.taskId,
      name: attachment.name,
      kind: attachment.kind,
      size: attachment.sizeBytes || 0,
    })));
    dropQueued(item, zh ? "无法取回这条消息" : "Could not take the message back");
  }

  async function startRemoteTask() {
    const desktopId = active?.id;
    const text = draft.trim();
    // The same guard the composer's own send has: a second press inside the round trip is the
    // same gesture, and asking twice is how one draft becomes two tasks.
    if (!desktopId || !text || sendingRef.current) return;
    setSending(true);
    sendingRef.current = true;
    setDraft("");
    const skill = selectedSkill;
    setSelectedSkill(null);
    try {
      const created = await window.shun.requestRemoteDesktop(desktopId, "task.create", {
        // The choice travels exactly as it is shown. The peer reads a *missing*
        // field as its own configured project, so a draft that says no project
        // has to say so out loud: omitting the field put the task in a project
        // this person never chose, and the row then appeared under it.
        workspace,
        ...(skill ? { skillId: skill.id } : {}),
        initialMessage: { text, runId: uid(), messageId: uid() },
      }) as { id?: string };
      await loadTasks(desktopId, true);
      if (created?.id) void openTask(desktopId, created.id);
    } catch (error) {
      setDraft((current) => current.trim() ? current : text);
      if (skill) setSelectedSkill(skill);
      notify({ tone: "error", title: zh ? "无法创建远端任务" : "Could not create a remote task", message: message(error) });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function loadEarlier() {
    const target = open;
    const current = viewRef.current;
    const first = current?.turns[0];
    if (!target || !current || !first) return;
    try {
      const page = await window.shun.requestRemoteDesktop(target.desktopId, "task.history", { taskId: target.taskId, beforeTurnId: first.id, turnLimit: 24 }) as { turns: RemoteTurn[]; history: { hasMore: boolean; cursor?: string } };
      if (viewRef.current?.taskId === target.taskId) setView(applyRemoteHistory(viewRef.current, page));
    } catch (error) {
      notify({ tone: "error", title: zh ? "无法读取更早的对话" : "Could not read earlier turns", message: message(error) });
    }
  }

  async function pair() {
    const code = pairCode.trim();
    if (!code || pairing) return;
    setPairing(true);
    setPairError("");
    try {
      const desktop = await window.shun.pairRemoteDesktop(code);
      setPairCode("");
      setShowPair(false);
      await refreshDesktops();
      setActiveId(desktop.id);
      void loadTasks(desktop.id, true);
      notify({ tone: "success", title: zh ? "已连上远端 Shun" : "Remote Shun connected", message: desktop.name });
    } catch (error) {
      setPairError(message(error));
    } finally {
      setPairing(false);
    }
  }

  async function unpair(id: string) {
    const desktop = desktopsRef.current.find((item) => item.id === id);
    // Dropping a link means pairing again on the other machine, from a code,
    // so it is a decision and not a stray click.
    if (!confirm(zh ? `断开与“${desktop?.name || id}”的配对？` : `Unpair “${desktop?.name || id}”?`)) return;
    await window.shun.unpairRemoteDesktop(id);
    if (openRef.current?.desktopId === id) {
      setOpen(null);
      setView(null);
      setPanel("none");
      setChanges(null);
      setResources(null);
      setRecords({});
    }
    await refreshDesktops();
  }

  useEffect(() => {
    void refreshPairedDevices();
    const pairedRefresh = setInterval(() => void refreshPairedDevices(), 15_000);
    void refreshDesktops().then((list) => {
      const connected = list.find((item) => item.connected) || list[0];
      if (connected) void loadTasks(connected.id, true);
    });
    const offConnection = window.shun.onRemoteDesktopConnection((event) => {
      let known = false;
      setDesktops((current) => {
        known = current.some((item) => item.id === event.id);
        return current.map((item) => item.id === event.id ? { ...item, ...event } : item);
      });
      // A machine whose state changed but which the list has never shown — the
      // first read happens before the main process has opened the stored
      // pairings — is read again rather than waited for.
      if (!known) void refreshDesktops();
      // A view of that machine's package is served through the link it was opened
      // on, so a link that is gone has nothing left to answer it with: it is
      // closed rather than left loading an origin nobody speaks for.
      if (!event.connected) {
        if (pluginViewRef.current?.desktopId === event.id) closePluginView();
        return;
      }
      if (!tasksRef.current[event.id]) void loadTasks(event.id, true);
      // A link that just came back may have missed pushes; the view is resynced
      // from the events it did not receive rather than from a whole snapshot.
      // What this window is looking at is not restored here: the link carries
      // that, and it says it again itself every time it connects.
      const target = openRef.current;
      if (event.resumed && target?.desktopId === event.id) void resync(target);
    });
    const offEvent = window.shun.onRemoteDesktopEvent(applyBatch);
    // Coming back to a slept machine is not a reconnect: the socket may look
    // open and answer nothing, so a live link is probed. A link that is already
    // down is left to its own backoff instead of being dialled on every focus.
    const wake = () => {
      const target = openRef.current;
      if (!target) return;
      if (!desktopsRef.current.find((item) => item.id === target.desktopId)?.connected) return;
      void window.shun.wakeRemoteDesktops().catch(() => {});
    };
    addEventListener("focus", wake);
    return () => {
      offConnection();
      offEvent();
      clearInterval(pairedRefresh);
      removeEventListener("focus", wake);
    };
  }, []);


  /**
   * A run that is going should visibly be going, and so should a compaction.
   *
   * Pushes carry both, and a push that is lost would leave the conversation on
   * whatever it last heard — reading as still running after the peer finished, or
   * as idle while the peer works, or refusing messages for a compaction that is
   * over. So the two sides are compared on a short clock, and the task is read
   * whole only when they disagree, which is what a lost push looks like. The
   * peer's own task list is the comparison, and it is one small round trip: the
   * same recovery the phone client uses when a link goes quiet.
   */
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      const target = openRef.current;
      if (!target) return;
      // The peer's own task list is the truth about whether it is working: a
      // view that wrongly reads as idle would otherwise never ask again, which
      // is how a streaming run could look silent here for as long as it ran.
      void loadTasks(target.desktopId, true);
      const peer = (tasksRef.current[target.desktopId] || []).find((task) => task.id === target.taskId);
      const peerIsWorking = peer?.status === "running";
      const view = viewRef.current;
      const viewIsRunning = view?.status === "running";
      // Two facts are carried by pushes and neither can be re-derived here: a run
      // being written, and a compaction running. A lost push, or a peer that
      // restarted in the middle of a compaction and so will never push again, is
      // this disagreement — and agreeing is not a silence to count, so the next
      // disagreement starts its own count rather than inheriting this one.
      if (peerIsWorking === viewIsRunning && Boolean(peer?.compacting) === Boolean(view?.compacting)) {
        unansweredReads.current = 0;
        return;
      }
      // The two sides disagreeing is exactly what a lost push looks like, and it
      // is the only reading this surface cannot resolve on its own: a view that
      // says a run is going over a peer that finished holds a spinner that only
      // looks like a run, a view that reads as idle over a peer that is working
      // never asks again, and a composer closed over a peer that is no longer
      // compacting refuses messages with no way back.
      //
      // While they agree, a whole-task read every interval is the conversation
      // asked for twice: the pushes are the same events, and a run that streams
      // for minutes was paying for a full read of itself the whole way. A gap
      // inside a live stream is already caught by its own sequence numbers, so
      // waiting for the disagreement loses nothing and asks for far less.
      //
      // A snapshot rather than a page of events, because it carries the run's
      // state and the conversation in one answer: it cannot come back "nothing
      // new" while the view is wrong.
      void refreshFromSnapshot(target).then((answered) => {
        if (viewRef.current?.taskId !== target.taskId) return;
        if (answered) {
          unansweredReads.current = 0;
          return;
        }
        // A view that says a run is going, over a peer that answers nothing at
        // all, is the one reading this surface cannot resolve by itself: the
        // state is the peer's, and silence is not a state. Swallowing it left a
        // spinner that only looked like a run, so it is said out loud once per
        // silence instead.
        unansweredReads.current += 1;
        if (unansweredReads.current !== REMOTE_UNANSWERED_READ_LIMIT) return;
        notify({
          tone: "error",
          title: zh ? "那台机器没有回应" : "The other machine stopped answering",
          message: zh
            ? "它最后一次说这个任务还在运行；Shun 会继续尝试读取。"
            : "Its last word was that this task is still running. Shun keeps trying to read it.",
        });
      });
    }, REMOTE_LIVE_RECOVERY_MS);
    return () => clearInterval(timer);
  }, [open?.taskId, open?.desktopId]);

  /**
   * Read the whole task again.
   *
   * Pushes make a conversation feel live, and this is what makes it correct: a
   * snapshot carries the run's state and the turns together, so it cannot come
   * back "nothing new" while the view is wrong. The phone client falls back to
   * the same call on the same clock.
   */
  async function refreshFromSnapshot(target: { desktopId: string; taskId: string }) {
    const current = viewRef.current;
    if (!current || current.taskId !== target.taskId) return true;
    try {
      const snapshot = await window.shun.requestRemoteDesktop(target.desktopId, "task.snapshot", { taskId: target.taskId, turnLimit: 40 }) as RemoteSnapshot;
      if (viewRef.current?.taskId !== target.taskId) return true;
      // Events that arrived while this was in flight belong after it.
      const queued = buffered.current;
      buffered.current = [];
      setView(applyRemoteEvents(applyRemoteSnapshot(current, snapshot), queued));
      return true;
    } catch {
      // A link that is down is already reported, and the next tick tries again.
      // The caller turns a peer that keeps not answering into something the
      // person can read, rather than a state the view keeps asserting alone.
      return false;
    }
  }

  async function loadPluginViews() {
    const target = openRef.current;
    if (!target) { setPluginViews([]); return; }
    try {
      // The workspace travels with the question: which views a rail is showing is
      // per project, and the machine that owns the rail is the one that knows.
      const listed = await window.shun.requestRemoteDesktop(target.desktopId, "plugin.views.list", { workspace: viewRef.current?.workspace || "" });
      if (openRef.current?.taskId !== target.taskId) return;
      setPluginViews(Array.isArray(listed)
        ? (listed as RemotePluginViewSummary[]).filter(view => view && typeof view.pluginId === "string" && typeof view.viewId === "string")
        : []);
    } catch {
      setPluginViews([]);
    }
  }

  /**
   * Open one of the other machine's views here.
   *
   * Two steps, in this order: that machine opens the view and answers with the
   * address of its own package and the token, and this machine opens a tunnel at
   * an origin of its own that serves exactly those files. What the surface then
   * loads is the package's own interface — the same file that machine would load
   * — which is why the two machines show one interface and not two.
   *
   * A view reads a project, and a project belongs to a task over there, so the
   * rail a project always shows is usable while its first message is still being
   * written: the draft becomes that task on the other machine first, exactly as
   * an attachment does.
   */
  async function openPluginView(request: { pluginId: string; viewId: string; title?: string }) {
    const open = openRef.current;
    const target = open ? { ...open, workspace: viewRef.current?.workspace || "" } : await draftTask();
    // A click that cannot act says so: the panel is what a person is waiting for, and
    // one that never appears without a word is indistinguishable from a dead window.
    if (!target) {
      notify({ tone: "info", title: zh ? "先选一台机器" : "Choose a machine first", message: zh ? "这个视图属于那台机器上的任务。" : "That view belongs to a task on the other machine." });
      return false;
    }
    const current = pluginViewRef.current;
    const same = current && current.desktopId === target.desktopId && current.taskId === target.taskId
      && current.view.pluginId === request.pluginId && current.view.viewId === request.viewId;
    if (same) {
      notify({ tone: "info", title: zh ? "这个视图已经打开" : "That view is already open", message: zh ? "它就在对话的右侧。" : "It is already on the right of the conversation." });
      return true;
    }
    if (current) closePluginView();
    const summary = pluginViewsRef.current.find(view => view.pluginId === request.pluginId && view.viewId === request.viewId);
    setPluginViewOpening({
      pluginId: request.pluginId,
      viewId: request.viewId,
      title: request.title || summary?.title || request.viewId,
      ...(summary?.icon ? { icon: summary.icon } : {}),
      ...(summary?.iconUrl ? { iconUrl: summary.iconUrl } : {}),
    });
    try {
      const opened = await window.shun.requestRemoteDesktop(target.desktopId, "plugin.view.open", {
        pluginId: request.pluginId, viewId: request.viewId, taskId: target.taskId,
        // The workspace the view is bound to is the one this task is in: a view
        // opened against another task's directory would read the wrong project.
        workspace: target.workspace,
      }) as RemoteOpenedPluginView;
      const served = await window.shun.remotePreviewOpen({
        desktopId: target.desktopId, taskId: target.taskId, url: String(opened.url || ""),
        key: pluginPreviewKey(request.pluginId, request.viewId),
        viewId: request.viewId, accessToken: String(opened.accessToken || ""),
        workspace: String(opened.boundWorkspace || ""),
      });
      // The task can be closed while a view is opening — and a task that was just
      // created for a draft is not in the view state yet. What the person is in is
      // the task that was created for it, or the one the close forgot.
      const still = openRef.current;
      if (still
        ? (still.desktopId !== target.desktopId || still.taskId !== target.taskId)
        : (attachmentTask.current.desktopId !== target.desktopId || attachmentTask.current.taskId !== target.taskId)) {
        void window.shun.remotePreviewClose(served.sessionId).catch(() => false);
        void window.shun.requestRemoteDesktop(target.desktopId, "plugin.view.close", { accessToken: String(opened.accessToken || "") }).catch(() => undefined);
        return false;
      }
      const entry = String(opened.entry || summary?.entry || "/");
      setPluginView({
        desktopId: target.desktopId,
        taskId: target.taskId,
        sessionId: served.sessionId,
        frameUrl: `${served.origin}${entry.startsWith("/") ? entry : `/${entry}`}`,
        view: remotePluginContribution(opened, summary, target.taskId),
      });
      return true;
    } catch (error) {
      notify({ tone: "error", title: zh ? "打不开那个插件视图" : "Could not open that plugin view", message: message(error) });
      return false;
    } finally {
      // Either the panel is the view now, or the failure was said out loud; the
      // placeholder belongs to neither of those moments.
      setPluginViewOpening(null);
    }
  }

  function closePluginView() {
    const current = pluginViewRef.current;
    setPluginView(null);
    if (!current) return;
    void window.shun.remotePreviewClose(current.sessionId).catch(() => false);
    void window.shun.requestRemoteDesktop(current.desktopId, "plugin.view.close", { accessToken: current.view.accessToken }).catch(() => undefined);
  }

  /**
   * One call out of a view that lives on the other machine.
   *
   * It is answered by the machine that has the package: a view's own host is the
   * one that can serve it, and this machine only carries the call.
   */
  async function invokePluginView(method: string, payload: unknown) {
    const current = pluginViewRef.current;
    if (!current) throw Error(zh ? "这个插件视图已经关闭。" : "This plugin view is no longer open.");
    return window.shun.requestRemoteDesktop(current.desktopId, "plugin.view.invoke", {
      pluginId: current.view.pluginId, viewId: current.view.viewId, accessToken: current.view.accessToken,
      method, payload, workspace: current.view.boundWorkspace, taskId: current.taskId,
    });
  }

  /**
   * A view the other machine's own interface asked to show.
   *
   * It arrives as the tool call that asked for it, on the conversation this
   * window is reading — so a view opens here the way it opens there, because it
   * is the same call, made once, read by both machines.
   */
  useEffect(() => {
    if (!open || !view?.ready) return;
    for (const turn of view.turns) for (const entry of turn.timeline) {
      if (entry.type !== "tool") continue;
      const request = entry.tool.pluginView;
      if (!request || request.disposition !== "open") continue;
      const answered = `${open.taskId}:${entry.tool.id}`;
      if (answeredPluginViews.current.has(answered)) continue;
      answeredPluginViews.current.add(answered);
      void openPluginView({ pluginId: request.pluginId, viewId: request.viewId, title: request.title });
    }
  }, [open?.taskId, view?.ready, view?.turns]);

  /**
   * Which branch the open task is on over there, read when it opens, whenever the
   * run behind it stops, and whenever a tool has run in it. One small read, and
   * the chip in the header never has to borrow this window's own repository to
   * say something about somebody else's task.
   */
  useEffect(() => {
    if (!open) { setRepository(null); return; }
    // A run settling is also when the other machine's rail may have changed: it
    // opens a view for the work that just finished, and this window draws it.
    void loadRepository();
    void loadPluginViews();
  }, [open?.taskId, view?.status]);

  /**
   * A checkout moves while a task works, not only when it stops.
   *
   * The chip says how much a task has touched, and it was read once when the task
   * opened and once when it settled — so through a long run it showed the count
   * from before that run began, beside a workbench already listing the files. A
   * settled tool is when this machine can know the other one's checkout may have
   * moved, debounced the way the same read is on the machine that owns it: a task
   * that keeps working keeps moving the point it is taken from.
   */
  useEffect(() => {
    if (!open || !lastSettledToolId) return;
    const timer = setTimeout(() => { void loadRepository(); }, REMOTE_REPOSITORY_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [open?.taskId, lastSettledToolId]);

  const activeTask = open ? (tasks[open.desktopId] || []).find((item) => item.id === open.taskId) : undefined;
  /**
   * The Skills the machine on the other side lets this conversation name.
   *
   * A Skill is that machine's to run, so what travels is a name: the peer lists
   * the ones this task — or, for a draft, this folder — may name, and resolves the
   * one a message carries against the task it runs in. What a Skill contains is
   * never part of the answer, which is why a controller can offer one it has never
   * read. It is asked again whenever the place the next run would happen changes,
   * because the answer belongs to that place and not to this window.
   */
  useEffect(() => {
    const desktopId = active?.id || "";
    if (!desktopId) { setPeerSkills([]); return; }
    let live = true;
    void window.shun.requestRemoteDesktop(desktopId, "skills.list", open ? { taskId: open.taskId } : { workspace })
      .then((list) => {
        if (!live) return;
        setPeerSkills(Array.isArray(list)
          ? list.filter((item) => item && typeof item.id === "string" && typeof item.name === "string")
            .map((item) => ({ id: item.id, name: item.name, description: typeof item.description === "string" ? item.description : "" }))
          : []);
      })
      .catch(() => { if (live) setPeerSkills([]); });
    return () => { live = false; };
  }, [active?.id, open?.taskId, workspace]);
  /**
   * What the open conversation is, kept for the next time somebody opens it.
   *
   * The view is already this window's own state; keeping the last few of them
   * costs a reference each and takes the round trip out of switching back.
   */
  useEffect(() => {
    const target = openRef.current;
    if (target && view?.ready) writeViewCache(target.desktopId, view);
  }, [view]);
  return {
    desktops,
    active,
    activeId,
    selectDesktop: (id: string) => { setActiveId(id); void loadTasks(id); },
    refreshDesktops,
    loadTasks,
    tasks,
    tasksLoading,
    open,
    openTask,
    pendingAttachments,
    setPendingAttachments,
    peerSkills,
    selectedSkill,
    chooseSkill: (skill: { id: string; name: string } | null) => setSelectedSkill(skill),
    attachFiles,
    attachFilesFrom,
    recallQueued,
    discardQueued,
    sendQueuedNow,
    remoteModels,
    modelMenu,
    setModelMenu,
    toggleModelMenu,
    loadModels,
    selectModel,
    closeTask: () => { declareWatch(open?.desktopId || "", []); attachmentTask.current = { desktopId: "", taskId: "" }; setOpen(null); setView(null); setTerminal(false); setPanel("none"); closePluginView(); },
    view,
    viewRef,
    running,
    records,
    loadToolRecord,
    expandedTool,
    setExpandedTool,
    expandedChange,
    setExpandedChange,
    panel,
    setPanel,
    changes,
    loadChanges,
    /** The other machine's repository for the open task: its branch, and how much it has moved. */
    repository,
    files,
    loadFiles,
    includeHidden,
    setIncludeHidden: (value: boolean) => {
      setIncludeHidden(value);
      void loadFiles(files?.path || undefined, value);
    },
    resources,
    loadResources,
    workspace,
    setWorkspace,
    chooseWorkspace,
    browsing,
    browseWorkspace,
    setBrowsing,
    terminal,
    setTerminal,
    /** The other machine's views, and the one of them open on this one. */
    pluginViews,
    pluginViewOpening,
    pluginView,
    loadPluginViews,
    openPluginView,
    closePluginView,
    invokePluginView,
    draft,
    setDraft,
    sending,
    compacting,
    sentTurnId,
    send,
    startRemoteTask,
    command,
    loadEarlier,
    saveFile,
    pair,
    unpair,
    pairedDevices,
    refreshPairedDevices,
    forgetDevice,
    showPair,
    setShowPair,
    pairCode,
    setPairCode,
    pairing,
    pairError,
    setPairError,
    activeTask,
  };
}

export type RemoteSession = ReturnType<typeof useRemoteSession>;
