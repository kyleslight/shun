const builtInWorkspaceTools = ['read', 'bash', 'edit', 'write'] as const

/**
 * Pi-style capability selection: configuration decides which tools exist for
 * the session. Prompt wording never removes capabilities from an individual
 * turn; the model decides whether a registered tool is relevant.
 */
export function activeToolNames(workspace: string, productToolNames: string[]) {
  return [...(workspace ? builtInWorkspaceTools : []), ...productToolNames]
}

export function capabilityPrompt(activeTools: string[]) {
  const lines = [
    'Tools listed in this session are real product capabilities. Use them when they are relevant; do not claim a listed capability is unavailable.',
  ]
  if (activeTools.includes('web_search') && activeTools.includes('web_read')) {
    lines.push('When an answer depends on information outside the conversation and workspace, use web_search and web_read to obtain evidence before answering.')
  }
  if (activeTools.some(name => builtInWorkspaceTools.includes(name as typeof builtInWorkspaceTools[number]))) {
    lines.push('Workspace tools are available because a folder is selected. Availability alone is not a request to inspect or modify it; use them only when the user request requires workspace work.')
  }
  if (activeTools.includes('background_start')) {
    lines.push('For long-running servers, watchers, and workers, use background_start. Observe and stop them by stable ID with background_list, background_output, and background_stop; do not rely on shell job control for managed background work.')
  }
  return lines
}
