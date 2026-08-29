export type PluginDevelopmentWorkspaceState =
  | { status: 'ready'; workspaceSelected: true }
  | { status: 'workspace_required'; workspaceSelected: false; message: string }

export function pluginDevelopmentWorkspaceState(workspaceValue: unknown): PluginDevelopmentWorkspaceState {
  if (String(workspaceValue || '').trim()) return { status: 'ready', workspaceSelected: true }
  return {
    status: 'workspace_required',
    workspaceSelected: false,
    message: 'Choose or create a workspace for this task before creating, validating, or development-installing a plugin package. Standalone task storage is private scratch space and is not a durable plugin source.',
  }
}
