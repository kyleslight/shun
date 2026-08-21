import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import preact from '@preact/preset-vite'

export default defineConfig({ main: { plugins: [externalizeDepsPlugin()] }, preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } } }, renderer: { plugins: [preact()] } })
