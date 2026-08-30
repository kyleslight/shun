/// <reference types="vite/client" />
import type { LocalPathApi, RemoteBridgeRequest, RemoteFileApi, RemoteWorkspaceApi, ShunApi, WorkspaceLifecycleApi } from '../../shared'
declare global { interface Window { shun: ShunApi & LocalPathApi & RemoteWorkspaceApi & RemoteFileApi & WorkspaceLifecycleApi; __shunDevDispatchRemoteRequest?: (request: RemoteBridgeRequest) => Promise<unknown>; __shunDevOpenTask?: (taskId: string) => void } }
export {}
