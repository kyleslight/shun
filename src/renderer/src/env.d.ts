/// <reference types="vite/client" />
import type { LocalPathApi, RemoteFileApi, RemoteWorkspaceApi, ShunApi } from '../../shared'
declare global { interface Window { shun: ShunApi & LocalPathApi & RemoteWorkspaceApi & RemoteFileApi } }
export {}
