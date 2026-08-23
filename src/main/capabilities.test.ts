import assert from 'node:assert/strict'
import test from 'node:test'
import { activeToolNames, capabilityPrompt, productSystemPrompt } from './capabilities.ts'

test('current-price requests cannot lose web capability to prompt classification', () => {
  const tools = activeToolNames(['history_search', 'web_search', 'web_read'])
  assert.deepEqual(tools, ['read', 'bash', 'edit', 'write', 'history_search', 'web_search', 'web_read'])
  assert.match(capabilityPrompt(tools).join('\n'), /outside.*web_search.*web_read/i)
})

test('standalone tasks keep local tools without pretending to have a workspace', () => {
  assert.deepEqual(activeToolNames(['web_search', 'web_read']), ['read', 'bash', 'edit', 'write', 'web_search', 'web_read'])
  assert.match(capabilityPrompt(activeToolNames([])).join('\n'), /selected workspace.*not a filesystem security boundary/i)
})

test('workspace reads advertise one bounded streaming boundary for files of any size', () => {
  const prompt = capabilityPrompt(activeToolNames(['read'])).join('\n')
  assert.match(prompt, /bounded streaming tool/i)
  assert.match(prompt, /multi-gigabyte text/i)
  assert.match(prompt, /overview.*search.*tail.*line\/byte ranges/i)
  assert.match(prompt, /streaming command or script/i)
})

test('local PDF capability advertises the built-in cross-platform reader', () => {
  const prompt = capabilityPrompt(activeToolNames(['read_pdf'])).join('\n')
  assert.match(prompt, /local PDF.*read_pdf.*absolute path/i)
  assert.match(prompt, /built in and cross-platform/i)
  assert.match(prompt, /do not install or invoke external PDF utilities/i)
})

test('local browser debugging is explicit and vision remains optional', () => {
  const prompt = capabilityPrompt(activeToolNames(['web_read', 'browser_debug'])).join('\n')
  assert.match(prompt, /browser_debug.*localhost.*instead of web_read/i)
  assert.match(prompt, /DOM.*console.*load state/i)
  assert.match(prompt, /screenshot when visual comparison helps/i)
  assert.match(prompt, /text diagnostics remain available/i)
})

test('Chrome Browser Use keeps tab ownership and external mutations explicit', () => {
  const prompt = capabilityPrompt(activeToolNames(['browser_tabs', 'browser_claim', 'browser_open', 'browser_snapshot', 'browser_act'])).join('\n')
  assert.match(prompt, /existing Chrome.*task-owned tab sessions/i)
  assert.match(prompt, /browser_tabs.*browser_claim.*browser_open/i)
  assert.match(prompt, /fresh accessibility refs/i)
  assert.match(prompt, /purpose-built plugin or API/i)
  assert.match(prompt, /Do not submit, send, post, upload, purchase.*unless the user explicitly requested/i)
})

test('uploaded files use stable task-owned tools instead of inferred filesystem paths', () => {
  const prompt = capabilityPrompt(activeToolNames(['attachment_list', 'attachment_read'])).join('\n')
  assert.match(prompt, /task-owned attachments/i)
  assert.match(prompt, /attachment_list.*single content-aware attachment_read/i)
  assert.match(prompt, /original source paths are deliberately unavailable/i)
  assert.match(prompt, /never use workspace read, bash, find, or filename search/i)
  assert.match(prompt, /returns image content for images and bounded semantic content/i)
  assert.match(prompt, /mode ocr or visual with one explicit page/i)
  assert.doesNotMatch(prompt, /attachment_view/)
})

test('plugin capabilities stay lazy and bounded', () => {
  const prompt = capabilityPrompt(activeToolNames(['mcp_list', 'mcp_call', 'plugin_tool_search'])).join('\n')
  assert.match(prompt, /Discover only the relevant server/i)
  assert.match(prompt, /do not enumerate unrelated plugin schemas/i)
  assert.match(prompt, /plugin_tool_search.*concise capability query/i)
  assert.match(prompt, /never installs, connects, or enables a plugin/i)
})

test('native phase-one plugins advertise their actual bounded connection semantics', () => {
  const prompt = capabilityPrompt(activeToolNames(['github_repo_list', 'github_repository', 'figma_read_design'])).join('\n')
  assert.match(prompt, /github_\* tools.*GitHub CLI/i)
  assert.match(prompt, /Filesystem Git remains authoritative/i)
  assert.match(prompt, /github_repo_list.*without a selected workspace/i)
  assert.match(prompt, /github_repository.*explicit owner\/name.*Git-backed task workspace/i)
  assert.match(prompt, /link-based, read-only REST integration/i)
  assert.match(prompt, /never claim.*edit the canvas.*official MCP/i)
})

test('installable Skill discovery stays separate while installed Skills use native progressive disclosure', () => {
  const prompt = capabilityPrompt(activeToolNames(['skill_catalog_search', 'skill_install', 'skill_run', 'skill_search'])).join('\n')
  assert.match(prompt, /available to install.*remote discovery/i)
  assert.match(prompt, /skill_catalog_search.*verify strong candidates with web_read/i)
  assert.match(prompt, /Never answer those questions from the local installed-Skill list/i)
  assert.match(prompt, /specific Skill source, use skill_install/i)
  assert.match(prompt, /only Skill installation boundary/i)
  assert.match(prompt, /installer resolves conventional nested skills\/ directories/i)
  assert.match(prompt, /never guess, prepend, or retry alternate repository paths/i)
  assert.match(prompt, /Never install Skills with Bash/i)
  assert.match(prompt, /never scan application directories or another agent’s configuration/i)
  assert.match(prompt, /visible installed Skills.*available-Skills context with exact SKILL\.md locations/i)
  assert.match(prompt, /Load a relevant Skill on demand with the canonical read tool/i)
  assert.match(prompt, /use skill_search for additional enabled Skills/i)
  assert.match(prompt, /skill_search.*installed and enabled Skills/i)
  assert.match(prompt, /use skill_run with the listed Skill name/i)
  assert.match(prompt, /Never run Python Skill scripts with Bash/i)
  assert.match(prompt, /install dependencies with system pip/i)
})

test('the product identity answers model questions without exposing the internal runtime', () => {
  const prompt = productSystemPrompt('deepseek-v4-flash')
  assert.match(prompt, /You are Shun/)
  assert.match(prompt, /deepseek-v4-flash/)
  assert.match(prompt, /authoritative product state/)
  assert.match(prompt, /Never claim that you cannot access or determine the current model/)
  assert.match(prompt, /project context files.*do not define your public identity/i)
  assert.match(prompt, /Do not present an internal runtime.*as Shun’s public identity/i)
  assert.match(prompt, /fine to discuss a harness/i)
  assert.doesNotMatch(prompt, /earendil|pi-agent/i)
})
