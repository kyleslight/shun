import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

/** Keep private scratch-directory IDs out of the shared prompt prefix; tool cwd stays exact. */
export function taskDirectoryPrompt(prompt: string, cwd: string) {
  const suffix = `\nCurrent working directory: ${cwd.replace(/\\/g, '/')}`
  const end = prompt.endsWith('\n') ? prompt.slice(0, -1) : prompt
  if (!end.endsWith(suffix)) return prompt
  return `${end.slice(0, -suffix.length)}\nCurrent working directory: . (All relative tool paths resolve in this task’s working directory.)${prompt.endsWith('\n') ? '\n' : ''}`
}

export function createTaskDirectoryContextExtension(projectless: boolean): ExtensionFactory {
  return api => {
    api.on('before_agent_start', (event, context) => {
      if (!projectless) return
      const systemPrompt = taskDirectoryPrompt(event.systemPrompt, context.cwd)
      if (systemPrompt !== event.systemPrompt) return { systemPrompt }
    })
  }
}
