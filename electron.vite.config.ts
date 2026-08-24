import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import preact from '@preact/preset-vite'
import { createRequire } from 'node:module'

const packageVersion = (createRequire(import.meta.url)('./package.json') as { version: string }).version

export default defineConfig({ main: { plugins: [externalizeDepsPlugin()] }, preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } } }, renderer: { plugins: [preact()], define: { __SHUN_VERSION__: JSON.stringify(packageVersion) } } })
