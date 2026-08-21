/// <reference types="vite/client" />
import type { ShunApi } from '../../shared'
declare global { interface Window { shun: ShunApi } }
export {}
