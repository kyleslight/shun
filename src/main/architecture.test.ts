import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = dirname(fileURLToPath(import.meta.url))

test('prompt wording cannot enter capability or hidden execution-policy control flow', async () => {
  const [index, runtime, capabilities] = await Promise.all([
    readFile(join(root, 'index.ts'), 'utf8'),
    readFile(join(root, 'agent-runtime.ts'), 'utf8'),
    readFile(join(root, 'capabilities.ts'), 'utf8'),
  ])

  const indexTextUses = index.split('\n').filter(line => line.includes('req.text'))
  assert.deepEqual(indexTextUses.map(line => line.trim()), [
    "void recordTaskEvent(req.taskId, { type: 'request', runId: req.id, text: req.text })",
    'const runtimeRequest = toolAttachments.length ? { ...req, text: `${req.text}${attachmentManifest(toolAttachments)}` } : req',
  ])
  const runtimeTextUses = runtime.split('\n').filter(line => line.includes('req.text'))
  assert.deepEqual(runtimeTextUses.map(line => line.trim()), ['await session.prompt(req.text, options.initialImages?.length ? { images: options.initialImages } : undefined)'])
  assert.match(index, /for \(const item of attached\.filter\(item => item\.kind === 'image'\)\)/)
  assert.match(index, /inlineImageIds\.add\(item\.id\)/)
  assert.doesNotMatch(index, /inlineImageNotice|name: 'attachment_view'/)
  assert.match(index, /name: 'attachment_read'[\s\S]*readAttachmentForModel/)
  assert.doesNotMatch(index, /visionEnabled|selectedModel\?\.inputModalities/)
  assert.match(runtime, /const hasImages = req\.attachments\?\.some\(item => item\.kind === 'image'\) === true/)
  assert.match(runtime, /input: hasImages \? \['text', 'image'\] : \['text'\]/)
  assert.match(index, /当前模型或 Provider 不支持图片输入/)
  assert.match(capabilities, /activeToolNames\(productToolNames: string\[\]\)/)
  assert.match(index, /const cwd = await taskWorkingDirectory\(req\)/)
  assert.match(index, /standaloneDir: join\(root, 'standalone'\)/)
  assert.match(index, /activeToolNames\(productTools\.map/)
  assert.match(index, /hasTrustRequiringProjectResources\(cwd\)/)
  assert.match(index, /resolveProjectTrust: \(\) => resolveTaskProjectTrust\(cwd\)/)
  assert.match(index, /does not restrict or expand read, write, edit, or shell access/)
  assert.doesNotMatch(capabilities, /\b(?:req|request)\./)
  assert.doesNotMatch(`${index}\n${runtime}`, /selectKernelRoute|workspaceIntent|researchIntent|requestsNoVerification/)
  assert.match(index, /const webResearch = new WebResearchPolicy\(\)/)
  assert.match(index, /outcomePolicy: webResearch/)
  assert.match(index, /name: 'web_search'[\s\S]*site: Type\.Optional[\s\S]*exact_phrases: Type\.Optional/)
  assert.match(index, /searchWeb\(args\.query, args\.max_results, \{ site: args\.site, exactPhrases: args\.exact_phrases, renderPage: renderWebPage, fetchResource: fetchWebResource \}\)/)
  assert.doesNotMatch(index, /toolNeedsApproval|agent:approve|type: 'approval'/)
  assert.doesNotMatch(index, /commandIsDestructive|commandUsesNetworkClient|localNetworkCommandAllowed/)
})

test('hidden research Chromium remains invisible and muted before navigation', async () => {
  const index = await readFile(join(root, 'index.ts'), 'utf8')
  const renderPage = index.slice(index.indexOf('const renderWebPage:'), index.indexOf('const fetchWebResource'))

  assert.match(renderPage, /show: false/)
  assert.match(renderPage, /focusable: false/)
  assert.match(renderPage, /skipTaskbar: true/)
  assert.match(renderPage, /page\.webContents\.setAudioMuted\(true\)/)
  assert.match(renderPage, /media-started-playing/)
  assert.ok(renderPage.indexOf('setAudioMuted(true)') < renderPage.indexOf('page.loadURL('))
})
