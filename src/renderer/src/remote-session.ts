import { useEffect, useRef, useState } from 'preact/hooks'
import type {
  RemoteDesktopConnectionEvent, RemoteDesktopEventBatch, RemoteDesktopState, RemoteDeviceState, RemoteTerminalFrame, WorkspaceDirectoryListing,
} from '../../shared'
import {
  appendOptimisticTurn, applyRemoteEvents, applyRemoteHistory, applyRemoteSnapshot, catchUpContinues, emptyRemoteTaskView, removeOptimisticTurn,
  type RemoteAttachment, type RemoteChangeEntry, type RemoteChangesState, type RemoteDiffEntry, type RemoteEvent, type RemoteResource,
  type RemoteSnapshot, type RemoteTaskSummary, type RemoteTaskView, type RemoteToolRecord, type RemoteTurn,
  type RemoteWorkspaceDirectory,
} from './remote-conversation'

/** How long a running remote task may go without word before the view asks itself. */
export const REMOTE_LIVE_RECOVERY_MS = 10_000

const uid = () => crypto.randomUUID()

export type UiLanguage = 'zh' | 'en'
export type NotifyInput = { tone: 'success' | 'error' | 'info'; title: string; message?: string }

/**
 * Everything a Remote link needs while someone is looking at it: the paired
 * machines, the task list of the one being driven, the conversation being
 * watched, and the commands that act on it.
 *
 * It is a hook and not a page because Remote is a mode of the app's own surface
 * — the sidebar lists its tasks, the feed draws its turns, the composer sends to
 * it — so the state has to live where those pieces can all reach it.
 */
export function useRemoteSession({ language, notify }: { language: UiLanguage; notify: (input: NotifyInput) => string }) {
  const zh = language === "zh";
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  const [desktops, setDesktops] = useState<RemoteDesktopState[]>([]);
  // The other direction: the devices paired *to* this machine.
  const [pairedDevices, setPairedDevices] = useState<RemoteDeviceState[]>([]);
  const [activeId, setActiveId] = useState("");
  const [tasks, setTasks] = useState<Record<string, RemoteTaskSummary[]>>({});
  const [tasksLoading, setTasksLoading] = useState(false);
  const [open, setOpen] = useState<{ desktopId: string; taskId: string } | null>(null);
  const [view, setView] = useState<RemoteTaskView | null>(null);
  const [draft, setDraft] = useState("");
  /** The message this person just sent, so the feed can land on it. */
  const [sentTurnId, setSentTurnId] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<Array<{ id: string; name: string; kind: RemoteAttachment['kind']; progress: number }>>([]);
  const [remoteModels, setRemoteModels] = useState<{ selected: string; models: Array<{ id: string; name?: string }> }>({ selected: "", models: [] });
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
  const [resources, setResources] = useState<RemoteResource[] | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [browsing, setBrowsing] = useState<RemoteWorkspaceDirectory | null>(null);
  const [files, setFiles] = useState<WorkspaceDirectoryListing | null>(null);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [expandedChange, setExpandedChange] = useState("");
  const openRef = useRef(open);
  const viewRef = useRef(view);
  const tasksRef = useRef(tasks);
  const desktopsRef = useRef(desktops);
  const buffered = useRef<RemoteEvent[]>([]);
  const openToken = useRef(0);
  openRef.current = open;
  viewRef.current = view;
  tasksRef.current = tasks;
  desktopsRef.current = desktops;

  const active = desktops.find((item) => item.id === activeId) || desktops[0];
  const activeTasks = active ? tasks[active.id] || [] : [];
  const openDesktop = open ? desktops.find((item) => item.id === open.desktopId) : undefined;
  const running = view?.status === "running";

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

  /** Catch up incrementally; only a gap the peer can no longer fill costs a snapshot. */
  async function resync(target: { desktopId: string; taskId: string }) {
    const current = viewRef.current;
    if (!current || current.taskId !== target.taskId) return;
    let next = current;
    for (let round = 0; round < 5 && !next.needsResync; round += 1) {
      let page: { events: RemoteEvent[]; hasMore?: boolean };
      try {
        page = await window.shun.requestRemoteDesktop(target.desktopId, "task.events", { taskId: target.taskId, afterSeq: next.latestSeq }) as { events: RemoteEvent[]; hasMore?: boolean };
      } catch {
        next = { ...next, needsResync: true };
        break;
      }
      const events = Array.isArray(page.events) ? page.events : [];
      if (!events.length) break;
      if (!catchUpContinues(next, events)) {
        next = { ...next, needsResync: true };
        break;
      }
      next = applyRemoteEvents(next, events);
      if (!page.hasMore) break;
    }
    if (next.needsResync) {
      try {
        const snapshot = await window.shun.requestRemoteDesktop(target.desktopId, "task.snapshot", { taskId: target.taskId, turnLimit: 40 }) as RemoteSnapshot;
        next = applyRemoteSnapshot(next, snapshot);
      } catch {
        return;
      }
    } else {
      next = { ...next, needsResync: false };
    }
    if (viewRef.current?.taskId === target.taskId) setView(next);
  }

  function applyBatch(batch: RemoteDesktopEventBatch) {
    const target = openRef.current;
    if (!target || target.desktopId !== batch.desktopId) return;
    // A batch can carry another task's progress (a title, a run that started):
    // the list follows along even when the open conversation is the busy one.
    if (batch.events.some((event) => event.taskId !== target.taskId)) void loadTasks(batch.desktopId, true);
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
    setOpen({ desktopId, taskId });
    setView(emptyRemoteTaskView(taskId));
    setExpandedTool("");
    setExpandedChange("");
    // A record or a change list belongs to the task it came from.
    setRecords({});
    setChanges(null);
    setResources(null);
    buffered.current = [];
    try {
      const snapshot = await window.shun.requestRemoteDesktop(desktopId, "task.snapshot", { taskId, turnLimit: 40 }) as RemoteSnapshot;
      if (token !== openToken.current) return;
      const queued = buffered.current;
      buffered.current = [];
      setView(applyRemoteEvents(applyRemoteSnapshot(emptyRemoteTaskView(taskId), snapshot), queued));
      void loadModels();
      if (panel === "changes") void loadChanges();
      if (panel === "resources") void loadResources();
    } catch (error) {
      if (token !== openToken.current) return;
      setOpen(null);
      setView(null);
      notify({ tone: "error", title: zh ? "打不开远端任务" : "Could not open the remote task", message: message(error) });
    }
  }

  async function command(kind: string, payload: Record<string, unknown>, onError?: string) {
    const target = openRef.current;
    if (!target) return false;
    try {
      await window.shun.requestRemoteDesktop(target.desktopId, kind, payload);
      return true;
    } catch (error) {
      notify({ tone: "error", title: onError || (zh ? "远端命令失败" : "The remote command failed"), message: message(error) });
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

  /** Send files to the machine that will read them, and keep them until the message goes. */
  async function attachFiles() {
    const target = openRef.current;
    if (!target) return;
    try {
      const uploaded = await window.shun.attachRemoteFiles(target.desktopId, target.taskId);
      if (!uploaded.length) return;
      setPendingAttachments((current) => [...current, ...uploaded.map((item) => ({
        id: item.id,
        name: item.name,
        kind: (item.kind as RemoteAttachment['kind']) || "document",
        progress: 100,
      }))]);
    } catch (error) {
      notify({ tone: "error", title: language === "zh" ? "文件没有传到那台机器" : "The file did not reach the other machine", message: error instanceof Error ? error.message : String(error) });
    }
  }

  function toggleModelMenu() {
    setModelMenu((current) => !current);
  }

  /** The model list belongs to the machine that runs the task, not to this one. */
  async function loadModels() {
    const target = openRef.current;
    if (!target) return;
    try {
      const list = await window.shun.requestRemoteDesktop(target.desktopId, "models.list") as { selected?: string; models?: Array<{ id: string; name?: string }> };
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

  async function send() {
    const target = open;
    const text = draft.trim();
    if (!target || (!text && !pendingAttachments.length) || sending) return;
    setSending(true);
    const messageId = uid();
    const runId = uid();
    const attachments = pendingAttachments.map((item) => ({ id: item.id, kind: item.kind, name: item.name }));
    const restored = pendingAttachments;
    // The message is on its way the moment it is sent: it appears, the composer
    // empties, and the feed is told where to go. Waiting for the other machine
    // would put a round trip between pressing Enter and the sentence leaving the
    // box, which is exactly where a message looks unsent.
    setDraft("");
    setPendingAttachments([]);
    setSentTurnId(messageId);
    setView((current) => current ? appendOptimisticTurn(current, { messageId, text, attachments }) : current);
    try {
      const sent = await command("task.message.send", { taskId: target.taskId, text, messageId, runId, attachments: attachments.map((item) => ({ id: item.id })) }, zh ? "消息没有发出去" : "The message was not sent");
      if (!sent) {
        // A message the other machine refused goes back to the person who wrote
        // it — unless they have already started typing something else.
        setView((current) => current ? removeOptimisticTurn(current, messageId) : current);
        setDraft((current) => current.trim() ? current : text);
        setPendingAttachments((current) => current.length ? current : restored);
      }
    } finally {
      setSending(false);
    }
  }

  async function startRemoteTask() {
    const desktopId = active?.id;
    const text = draft.trim();
    if (!desktopId || !text || sending) return;
    setSending(true);
    setDraft("");
    try {
      const created = await window.shun.requestRemoteDesktop(desktopId, "task.create", {
        ...(workspace ? { workspace } : {}),
        initialMessage: { text, runId: uid(), messageId: uid() },
      }) as { id?: string };
      await loadTasks(desktopId, true);
      if (created?.id) void openTask(desktopId, created.id);
    } catch (error) {
      setDraft((current) => current.trim() ? current : text);
      notify({ tone: "error", title: zh ? "无法创建远端任务" : "Could not create a remote task", message: message(error) });
    } finally {
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
      if (!event.connected) return;
      if (!tasksRef.current[event.id]) void loadTasks(event.id, true);
      // A link that just came back may have missed pushes; the view is resynced
      // from the events it did not receive rather than from a whole snapshot.
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
   * A run that is going should visibly be going.
   *
   * Pushes carry it, and a push that is lost would leave the conversation on
   * whatever it last heard — reading as still running after the peer finished,
   * or as idle while the peer works. So a running remote task is checked on a
   * short clock: the catch-up costs one round trip and returns nothing when
   * there is nothing to catch up on, which is the same recovery the phone client
   * uses when a link goes quiet.
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
      const peerIsWorking = (tasksRef.current[target.desktopId] || []).some((task) => task.id === target.taskId && task.status === "running");
      const viewIsRunning = viewRef.current?.status === "running";
      // While either side says a run is going, read the whole task rather than a
      // page of events: a page can come back empty while the view is still
      // missing a delta it never applied, and a reply that is an empty bubble is
      // exactly that. A snapshot cannot be "nothing new" and wrong at once.
      if (peerIsWorking || viewIsRunning) void refreshFromSnapshot(target);
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
    if (!current || current.taskId !== target.taskId) return;
    try {
      const snapshot = await window.shun.requestRemoteDesktop(target.desktopId, "task.snapshot", { taskId: target.taskId, turnLimit: 40 }) as RemoteSnapshot;
      if (viewRef.current?.taskId !== target.taskId) return;
      // Events that arrived while this was in flight belong after it.
      const queued = buffered.current;
      buffered.current = [];
      setView(applyRemoteEvents(applyRemoteSnapshot(current, snapshot), queued));
    } catch {
      // A link that is down is already reported; the next tick tries again.
    }
  }

  const activeTask = open ? (tasks[open.desktopId] || []).find((item) => item.id === open.taskId) : undefined;
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
    attachFiles,
    remoteModels,
    modelMenu,
    toggleModelMenu,
    loadModels,
    selectModel,
    closeTask: () => { setOpen(null); setView(null); setTerminal(false); setPanel("none"); },
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
    browsing,
    browseWorkspace,
    setBrowsing,
    terminal,
    setTerminal,
    draft,
    setDraft,
    sending,
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
