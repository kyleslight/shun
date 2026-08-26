/// <reference types="vite/client" />
import type { LocalPathApi, ShunApi } from '../../shared'
declare global { interface Window { shun: ShunApi & LocalPathApi } }
export {}
