import { recentConversations } from '../conversation-list.ts'
import { resolve } from 'node:path'
import type { HostCall, HostTask } from '../host/protocol.ts'

type Choose = (label: string, items: Array<{ value: string; label: string; description?: string }>) => Promise<string>
export async function chooseSession(call: HostCall, workspace: string, choose: Choose): Promise<string | undefined> {
  const tasks = recentConversations(await call('task.list') as HostTask[])
  const scoped = tasks.filter(task => task.workspace === workspace)
  const item = (task: HostTask) => ({ value: task.id, label: task.title, description: task.workspace || 'No project selected' })
  let selected = await choose('Resume conversation · current workspace', [
    ...scoped.map(item), { value: '__new__', label: 'New conversation' },
    ...(tasks.length > scoped.length ? [{ value: '__all__', label: 'Show all workspaces…' }] : []),
  ])
  if (selected === '__all__') selected = await choose('Resume conversation · all workspaces', tasks.map(item))
  return selected === '__new__' ? undefined : selected
}

export async function startSession(call: HostCall, options: { workspace: string; taskId?: string; continueRecent?: boolean; resume?: boolean }, choose: Choose): Promise<HostTask> {
  let id = options.taskId
  if (options.resume) id = await chooseSession(call, options.workspace, choose)
  if (options.continueRecent) {
    const tasks = recentConversations(await call('task.list') as HostTask[])
    id = tasks.filter(task => task.workspace === options.workspace)[0]?.id
  }
  if (id) return (await call('task.snapshot', { taskId: id })).task
  return call('task.create', { workspace: options.workspace })
}

export function launchOptions(args: string[], cwd: string) {
  let positional: string | undefined
  if (!['run', 'tasks', 'desktop'].includes(args[0])) {
    for (let index = 0; index < args.length; index++) {
      const argument = args[index]
      if (['--task', '--session', '--workspace'].includes(argument)) { index++; continue }
      if (['-c', '--continue', '-r', '--resume', '--no-workspace'].includes(argument)) continue
      if (!argument.startsWith('-') && positional === undefined) { positional = argument; continue }
      throw Error(`Unknown argument: ${argument}. Run shun --help.`)
    }
  }
  const value = (flag: string) => {
    const index = args.indexOf(flag)
    if (index < 0) return undefined
    if (!args[index + 1] || args[index + 1].startsWith('-')) throw Error(`Provide a value for ${flag}.`)
    return args[index + 1]
  }
  const taskId = value('--task') || value('--session')
  const continueRecent = args.includes('-c') || args.includes('--continue')
  const resume = args.includes('-r') || args.includes('--resume')
  const explicit = value('--workspace')
  if (explicit && positional) throw Error('Provide only one workspace path.')
  const directory = explicit || positional, standalone = args.includes('--no-workspace')
  if (standalone && directory) throw Error('Choose --workspace or --no-workspace, not both.')
  if ([Boolean(taskId), continueRecent, resume].filter(Boolean).length > 1) throw Error('Choose one of --session, --continue, or --resume.')
  return { taskId, continueRecent, resume, workspace: directory ? resolve(cwd, directory) : '' }
}
