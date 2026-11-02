/** Real configured model, isolated sessions; no real mail, monitoring or file mutations.
 * Measures multi-topic recall and compaction separately from UI/network delivery.
 * node --experimental-strip-types scripts/assistant-context-live.mjs
 */
import { readFile, writeFile, mkdir, mkdtemp, readdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runAgentSession, compactAgentSession } from '../src/main/agent-runtime.ts'
import { AssistantTopicStore, assistantTopicTools, assistantTopicExtension } from '../src/main/assistant-topics.ts'
import { AssistantMemoryStore, assistantMemoryTools, assistantContextExtension } from '../src/main/assistant-memory.ts'
import { assistantContextPolicy } from '../src/main/assistant-context.ts'
import { continueAssistantTask } from '../src/main/assistant-task-continuation.ts'
import { createRequestTimingExtension } from '../src/main/request-timing.ts'
const resume = process.env.SHUN_BENCH_RESUME
const directory = resume || await mkdtemp(join(tmpdir(), 'shun-context-live-'))
const saved = JSON.parse(await readFile(process.env.SHUN_BENCH_STATE || join(homedir(), 'Library/Application Support/Shun/state.json'), 'utf8'))
let shared = {}; try { shared = JSON.parse(await readFile(join(homedir(), '.shun/providers.json'), 'utf8')).config || {} } catch {}
const configured = { ...saved.settings, ...shared }
const selectedProvider = configured.providers.find(provider => provider.id === configured.providerId)
const selectedModel = selectedProvider?.models?.find(model => model.id === configured.model)
const settings = { ...configured, contextWindow: selectedModel?.contextWindow || configured.contextWindow, maxTokens: selectedModel?.maxOutputTokens || configured.maxTokens, workspace: directory }
const taskId = resume ? (await readdir(join(directory, 'sessions'))).find(name => name.endsWith('.jsonl')).split('_').at(-1).replace('.jsonl', '') : randomUUID(), common = { cwd: directory, agentDir: join(directory, 'agent'), sessionDir: join(directory, 'sessions'), enableExtensionTools: false }
await mkdir(common.agentDir, { recursive: true })
const topics = new AssistantTopicStore(join(directory, 'topics.json')), memory = new AssistantMemoryStore(join(directory, 'memory.json'))
const results = resume ? JSON.parse(await readFile(join(directory, 'results.json'), 'utf8')).results : [], timings = []
const prompts = [
  '先记住这个视频项目，不执行：做一部15到20分钟的科普片，现在只交付开头60秒。不要把整片压缩成60秒，不要用大标题加字幕的PPT形式。只简短确认。',
  '换个话题，邮件监听需求先记住别启动：只报告真正新增且需要我处理的邮件；空检查安静；不要每次检查创建activity。',
  '第三件事，双机推理的验收目标：要区分冷prefill、缓存命中和排队。不能拿缓存命中的速度当冷启动提升。现在只记住。',
  '第四件事，Desktop UI：左上角头像视觉居中；除了手机配对，底部按钮都放进更多。先记需求，不执行。',
  '回到视频，纠正一下：语速在合成阶段调整，不能对生成音频做atempo或其他后期加速。稿子不删虚词来凑时长。',
  '邮件再补充：同一个thread如果我已经回复了，之前那封不再提醒；新的未处理信息仍要提醒。',
  '回到推理，两个任务并发的时候也要测P95，不能只报最快一次。',
  '界面再补一条：Running和右侧执行时长要视觉垂直居中，On it后面的点按0、1、2、3循环。',
  '视频到底是整片60秒还是只做开头？语速怎么处理？有哪些不能做？直接回答，不要执行。',
  '邮件什么情况下提醒、什么情况下安静？之前回复过的thread后来又有新问题呢？不要执行。',
  '推理验收你现在记住了哪些条件？不要执行。',
  'Desktop那几处界面需求完整列一下，不要混入视频或邮件的要求。不要执行。',
]
async function run(text, label) {
  const request = { id: randomUUID(), messageId: randomUUID(), taskId, text, settings, history: [] }
  const policy = assistantContextPolicy(request, 'assistant'), events = [], start = Date.now(), requestTimings = []
  const tools = [...assistantTopicTools(topics, taskId, { messageId: request.messageId, text }, async () => false), ...assistantMemoryTools(memory, taskId)]
  await runAgentSession(policy.request, AbortSignal.timeout(180000), event => events.push({ at: Date.now(), ...event }), {
    ...common, compactionSettings: policy.compactionSettings, customTools: tools, activeTools: tools.map(tool => tool.name),
    extensions: [assistantContextExtension({ personal: true, readUpdates: async () => [] }), assistantTopicExtension(topics, taskId), createRequestTimingExtension(timing => requestTimings.push(timing))],
  })
  const row = { label, elapsedMs: Date.now() - start, firstVisibleMs: events.find(event => event.type === 'delta')?.at - start,
    status: events.findLast(event => ['done', 'error', 'cancelled'].includes(event.type))?.type,
    answer: events.filter(event => event.type === 'delta').map(event => event.text || '').join(''), timings: requestTimings }
  results.push(row); timings.push(...requestTimings)
  await writeFile(join(directory, 'results.json'), JSON.stringify({ model: settings.model, results }, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ label, elapsedMs: row.elapsedMs, firstVisibleMs: row.firstVisibleMs, status: row.status, firstDeltaMs: requestTimings[0]?.firstDeltaMs, cacheReadTokens: requestTimings[0]?.cacheReadTokens }))
  if (row.status !== 'done' || !row.answer.trim()) throw Error('This scenario ended without a complete visible answer.')
}
console.log(JSON.stringify({ directory, model: settings.model, contextWindow: settings.contextWindow, maxTokens: settings.maxTokens, scope: 'real model, production session and topic services, synthetic user scenarios' }))
for (let i = resume ? 8 : 0; !process.argv.includes('--concurrency-only') && i < prompts.length; i++) {
  if (i === 8 && !resume && process.argv.includes('--long-history')) {
    const evidence = Array.from({ length: 1500 }, (_, n) => `Archived tool record ${n}: frame=${n * 30}; audio_duration=59.77; render_check=passed; source_revision=${n}; no change to user requirements.`).join('\n')
    await run(`下面是历史工具日志，只作为可回查材料，不是新的要求。四个话题的已有要求都保持不变，无需复述日志，只回复收到。\n${evidence}`, 'long-history-ingestion')
  }
  if (i === 8 && !resume && !process.argv.includes('--long-history')) {
    const start = Date.now()
    const summary = await compactAgentSession({ id: randomUUID(), taskId, text: '', history: [], settings }, { ...common, signal: AbortSignal.timeout(120000) }, 'Keep all four topics distinct, including latest corrections, constraints and unfinished work. Preserve topic IDs.')
    results.push({ label: 'explicit-compaction-boundary', elapsedMs: Date.now() - start, ...summary })
    console.log(JSON.stringify({ label: 'explicit-compaction-boundary', elapsedMs: Date.now() - start, tokensBefore: summary.tokensBefore, tokensAfter: summary.tokensAfter }))
  }
  try { await run(prompts[i], `turn-${i+1}`) } catch (error) { console.error(JSON.stringify({ label: `turn-${i+1}`, error: String(error) })); process.exitCode = 1; break }
}
await writeFile(join(directory, 'results.json'), JSON.stringify({ model: settings.model, results, topics: await topics.list(taskId) }, null, 2), { mode: 0o600 })

if (process.argv.includes('--concurrency-only')) {
  for (let round = 1; round <= 3; round++) {
    const child = { id: randomUUID(), parentTaskId: taskId, title: 'Video opening', workspace: directory, turns: [], createdAt: Date.now(), updatedAt: Date.now() }
    let activeId, settled, controller, firstDelta
    const startWorker = (text) => {
      activeId = randomUUID(); controller = new AbortController()
      const events = [], start = Date.now(), workerTimings = []
      let begun; firstDelta = new Promise(resolve => { begun = resolve })
      const req = { id: activeId, taskId: child.id, messageId: randomUUID(), text, history: [], settings }
      settled = runAgentSession(req, controller.signal, event => { events.push(event); if (['reasoning', 'delta', 'tool'].includes(event.type)) begun() }, {
        ...common, activeTools: [], extensions: [createRequestTimingExtension(timing => workerTimings.push(timing))],
      }).catch(error => { if (!controller.signal.aborted) throw error }).finally(() => { activeId = undefined; begun() })
      return { events, start, timings: workerTimings }
    }
    startWorker('设计一部15到20分钟科普片的开头60秒，给出30个详细镜头，逐条说明画面和台词。不要调用工具。')
    await firstDelta
    const foreground = run('邮件监听空检查要发报告吗？只回答：不发。', `concurrent-parent-${round}`)
    const correctionAt = Date.now(); let stoppedAt, submittedAt, corrected
    await continueAssistantTask([child], taskId, { taskId: child.id, prompt: '立即纠正：不要输出30个镜头，只回答你理解了：这次只交开头60秒，不把整片压缩成60秒，语速在合成阶段调整，不能后期加速。', interrupt: true }, {
      active: () => activeId,
      enqueue: async () => { throw Error('Urgent correction must not queue behind the old run') },
      stop: async () => { controller.abort(); await settled; stoppedAt = Date.now() },
      run: async () => { corrected = startWorker('立即纠正：不要输出30个镜头，只用一句话说明你理解了：这次只交开头60秒，不把整片压缩成60秒，语速在合成阶段调整，不能后期加速。'); submittedAt = Date.now(); return { taskId: child.id, title: child.title } },
    })
    await Promise.all([foreground, settled])
    const row = { label: `correction-${round}`, stopMs: stoppedAt - correctionAt, submittedMs: submittedAt - correctionAt, elapsedMs: Date.now() - correctionAt, answer: corrected.events.filter(e => e.type === 'delta').map(e => e.text || '').join(''), timings: corrected.timings }
    results.push(row); console.log(JSON.stringify({ ...row, answer: undefined, timings: undefined }))
    await writeFile(join(directory, 'results.json'), JSON.stringify({ model: settings.model, results }, null, 2), { mode: 0o600 })
  }
}
