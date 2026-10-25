import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { createShellTool } from '../main/shell-tool.ts'
import { createWorkspaceReadTool } from '../main/workspace-read.ts'
import { createWorkspaceEditTool } from '../main/workspace-edit.ts'
import type { BackgroundTaskManager } from '../main/background-tasks.ts'
import type { HostTask } from './protocol.ts'

export function hostTools(task: HostTask, runId: string, background: BackgroundTaskManager): ToolDefinition[] {
  const tools: ToolDefinition[] = [createWorkspaceReadTool(task.workspace)]
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: undefined })
  tools.push(createWorkspaceEditTool(task.workspace), createShellTool(task.workspace),
    defineTool({ name: 'background_start', label: 'Start background process', description: 'Start a task-owned server, watcher, or other long-running program.',
      parameters: Type.Object({ command: Type.String(), label: Type.Optional(Type.String()) }),
      execute: async (_id, args) => result(await background.start({ sessionId: task.id, createdByRunId: runId, workspace: task.workspace, cwd: task.workspace, ...args })),
    }),
    defineTool({ name: 'background_list', label: 'List background processes', description: 'List this task’s background processes.', parameters: Type.Object({}),
      execute: async () => result(background.list(task.id)),
    }),
    defineTool({ name: 'background_read', label: 'Read background output', description: 'Read bounded output from a task-owned background process.',
      parameters: Type.Object({ id: Type.String(), afterSeq: Type.Optional(Type.Integer({ minimum: 0 })) }),
      execute: async (_id, args) => result(await background.observe(task.id, args.id, { afterSeq: args.afterSeq, maxChars: 16000 })),
    }),
    defineTool({ name: 'background_stop', label: 'Stop background process', description: 'Stop a task-owned background process and its process group.',
      parameters: Type.Object({ id: Type.String() }), execute: async (_id, args) => result(await background.stop(task.id, args.id)),
    }),
  )
  return tools
}
