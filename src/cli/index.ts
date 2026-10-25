import { slashCommands } from './commands.ts'
import { connectHost } from './connection.ts'
import { createHostClient, startHostServer, verifyHost } from '../host/transport.ts'
import { runTui } from './tui.ts'
import { launchOptions } from './sessions.ts'
import { installDesktop, openDesktop } from './desktop.ts'
import type { TaskEventEnvelope } from '../shared.ts'

declare const SHUN_CLI_VERSION: string
const version = typeof SHUN_CLI_VERSION === 'undefined' ? 'development' : SHUN_CLI_VERSION
const args = process.argv.slice(2)
async function main() {
  if (args.includes('--version') || args.includes('-v')) { console.log(`Shun ${version}`); return }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Shun ${version}\n\nshun                       Start a conversation without a workspace\nshun .                     Start a conversation in the current directory\nshun <path>                Start a conversation in a workspace\nshun --task <id>            Connect to an existing task\nshun --workspace <path>     Start in a workspace\nshun -c / --continue        Continue the latest conversation in this workspace\nshun -r / --resume          Choose a previous conversation\nshun --session <id>         Reconnect to a conversation\nshun run <message>          Run a message and stream output\n  --task <id>              Continue a saved task\nshun tasks                 List tasks\nshun service status        Inspect the background service\nshun service stop          Stop the service when tasks are idle\nshun desktop               Open the desktop interface\nshun desktop --install     Download and verify the desktop installer\n\nIn the terminal:\n${slashCommands.map(item => `/${item.name.padEnd(14)} ${item.description}`).join('\n')}\n/paste attaches a clipboard image locally; /attach imports an image file.\nCtrl+D detaches; active tasks keep running. Ctrl+C stops generation or returns home; press twice at home to exit. /stop stops the current run.\n\nInstall: npm i -g @shunagent/shun\nData: ~/.shun (override with SHUN_HOME)`)
    return
  }
  if (args[0] === '--serve') {
    process.title = 'shun-service'
    const host = await startHostServer()
    let stopping = false
    const stop = () => { if (stopping) return; stopping = true; void host.close().then(() => process.exit(0)) }
    process.on('SIGTERM', stop); process.on('SIGINT', stop)
    host.server.once('shun-stop', stop)
    return
  }
  if (args[0] === 'service') {
    const call = createHostClient()
    if (args[1] === 'stop') { await call('service.stop'); console.log('Shun service is stopping.'); return }
    if (!args[1] || args[1] === 'status') { const hello = await verifyHost(call); console.log(`Shun service is running (PID ${hello.pid}).`); return }
    throw Error('Use shun service status or shun service stop.')
  }
  if (args[0] === 'desktop' && args.includes('--install')) { await installDesktop(console.log); return }
  const launch = launchOptions(args, process.cwd())
  const { taskId, workspace } = launch
  const client = new AbortController()
  const call = await connectHost(undefined, client.signal)
  if (args[0] === 'desktop') { await openDesktop(taskId); return }
  if (args[0] === 'tasks') { for (const task of await call('task.list')) console.log(`${task.id}\t${task.activeRun ? 'running' : 'idle'}\t${task.title}`); return }
  if (args[0] === 'run') {
    const message: string[] = []
    for (let i = 1; i < args.length; i++) {
      if (['--task', '--session', '--workspace'].includes(args[i])) { i++; continue }
      if (args[i] === '--write' || args[i] === '--no-workspace') continue
      if (args[i].startsWith('--')) throw Error(`Unknown option: ${args[i]}`)
      message.push(args[i])
    }
    if (!message.length) throw Error('Provide a message: shun run "your request"')
    const task = taskId ? { id: taskId } : await call('task.create', { workspace })
    const snapshot = await call('task.snapshot', { taskId: task.id })
    let sequence = snapshot.sequence
    const { runId } = await call('task.send', { taskId: task.id, text: message.join(' ') })
    console.error(`Task: ${task.id}`)
    const stop = () => { void call('task.stop', { taskId: task.id }).catch(() => {}) }
    process.on('SIGINT', stop)
    try {
      let done = false
      while (!done) {
        const batch = await call('task.events', { taskId: task.id, after: sequence })
        for (const envelope of batch.events as TaskEventEnvelope[]) {
          sequence = envelope.seq
          if (envelope.payload.type !== 'agent' || envelope.payload.runId !== runId) continue
          const event = envelope.payload.event
          if (event.type === 'delta') process.stdout.write((event.text || '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''))
          if (event.type === 'error') { console.error(event.text); process.exitCode = 1 }
          if (event.type === 'cancelled') process.exitCode = 130
          if (['done', 'cancelled', 'error'].includes(event.type)) done = true
        }
        if (!batch.activeRun && !batch.events.length && !done) throw Error('The run ended without a completion event. Reconnect with shun --task ' + task.id)
        if (!done) await new Promise(resolve => setTimeout(resolve, 150))
      }
      process.stdout.write('\n')
    } finally { process.off('SIGINT', stop) }
    return
  }
  await runTui(call, { ...launch, onClose: () => client.abort() })
}
main().catch(error => { console.error(`Shun: ${error instanceof Error ? error.message : 'Operation failed.'}`); process.exitCode = 1 })
