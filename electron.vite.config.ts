import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import preact from '@preact/preset-vite'
import { createRequire } from 'node:module'

const packageVersion = (createRequire(import.meta.url)('./package.json') as { version: string }).version

// A bundled OAuth client registration never lives in this repository, because a
// committed client secret is a published one. The build reads it from the
// environment and bakes it into the main bundle, so an installed build carries
// its own Google client without reading the environment at runtime. See
// src/main/oauth-clients.ts and RELEASING.md.
const oauthClientDefines = {
  'process.env.SHUN_GOOGLE_OAUTH_CLIENT_ID': JSON.stringify(process.env.SHUN_GOOGLE_OAUTH_CLIENT_ID ?? ''),
  'process.env.SHUN_GOOGLE_OAUTH_CLIENT_SECRET': JSON.stringify(process.env.SHUN_GOOGLE_OAUTH_CLIENT_SECRET ?? ''),
}

export default defineConfig({ main: { plugins: [externalizeDepsPlugin()], define: oauthClientDefines }, preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } } }, renderer: { plugins: [preact()], define: { __SHUN_VERSION__: JSON.stringify(packageVersion) } } })
