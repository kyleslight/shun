import assert from 'node:assert/strict'
import test from 'node:test'
import { activeToolNames, capabilityPrompt, executionStrategyPrompt, productSystemPrompt, productToolNamesToDefer } from './capabilities.ts'

test('current-price requests cannot lose web capability to prompt classification', () => {
  const tools = activeToolNames(['history_search', 'web_search', 'web_read'])
  assert.deepEqual(tools, ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'history_search', 'web_search', 'web_read'])
  assert.match(capabilityPrompt(tools).join('\n'), /outside.*web_search.*web_read/i)
  assert.match(capabilityPrompt(tools).join('\n'), /snippets are discovery leads.*not verified facts/i)
  assert.match(capabilityPrompt(tools).join('\n'), /separate research network path.*not evidence.*Chrome is blocked/i)
  assert.match(capabilityPrompt(tools).join('\n'), /verify the vendor.s official source.*official tool.*wrong-tool rework/i)
})

test('standalone tasks keep local tools without pretending to have a workspace', () => {
  assert.deepEqual(activeToolNames(['web_search', 'web_read']), ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'web_search', 'web_read'])
  assert.match(capabilityPrompt(activeToolNames([])).join('\n'), /selected workspace.*not a filesystem security boundary/i)
  const standalone = capabilityPrompt(activeToolNames(['web_search', 'web_read']), { workspaceSelected: false }).join('\n')
  assert.match(standalone, /private task-owned storage.*lasts with the task.*temporary scripts.*generated artifacts.*complete project.*use it silently/i)
  assert.match(standalone, /no preselected user project context.*never inspect its initial state hoping to answer a general question.*initial emptiness.*missing user data/i)
  assert.match(standalone, /Do not mention or expose its absolute path or internal layout/i)
  assert.match(standalone, /relevant external capability.*current or external information/i)
  const selectedWorkspace = capabilityPrompt(activeToolNames([]), { workspaceSelected: true }).join('\n')
  assert.doesNotMatch(selectedWorkspace, /private task-owned storage/i)
  assert.match(selectedWorkspace, /Keep the absolute task root private.*refer to files relative to it/i)
})

test('core research and project preview stay eager while low-frequency product tools use progressive disclosure', () => {
  const product = ['read', 'attachment_list', 'attachment_read', 'web_search', 'web_read', 'schedule_create', 'background_start', 'background_list', 'background_output', 'background_stop', 'browser_debug', 'browser_preview_act']
  assert.deepEqual(productToolNamesToDefer(product, false), ['attachment_list', 'attachment_read', 'schedule_create'])
  assert.deepEqual(productToolNamesToDefer(product, true), ['schedule_create'])
})

test('workspace reads advertise one bounded streaming boundary for files of any size', () => {
  const prompt = capabilityPrompt(activeToolNames(['read'])).join('\n')
  assert.match(prompt, /bounded streaming tool/i)
  assert.match(prompt, /multi-gigabyte text/i)
  assert.match(prompt, /overview.*in-file search.*tail.*line\/byte ranges/i)
  assert.match(prompt, /grep.*repository-wide content search/i)
  assert.match(prompt, /prefer them over shell pipelines/i)
})

test('workspace edits require one coherent atomic file batch', () => {
  const prompt = capabilityPrompt(activeToolNames([])).join('\n')
  assert.match(prompt, /one-shot atomic batch boundary/i)
  assert.match(prompt, /Do not split the file into sequential edit batches/i)
})

test('explicit execution strategies stay bounded and prefer the smallest complete change', () => {
  const balanced = executionStrategyPrompt().join('\n')
  assert.match(balanced, /Working style: Balanced/i)
  assert.match(balanced, /Understand the affected contract.*prefer an early implementation/i)
  assert.match(balanced, /smallest complete change/i)
  assert.match(balanced, /correctness, readability, and necessary tests/i)
  assert.match(balanced, /task scope and observed results, not uncertainty alone/i)
  assert.doesNotMatch(balanced, /fewest lines|line limit|benchmark/i)
  assert.doesNotMatch(balanced, /concrete failure|contradiction|shared contract|multiple subsystems/i)
  const fast = executionStrategyPrompt('fast').join('\n')
  assert.match(fast, /Working style: Fast.*Orient briefly.*earliest safe complete change/i)
  assert.match(executionStrategyPrompt('deliberate').join('\n'), /Working style: Deliberate.*relevant contracts and call paths/i)
})

// The guidance wall is the agent's map of its own capabilities. Two invariants keep
// that map honest and bounded, and both are behavioral: they hold for any wording.
const activeForOneTask = ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'web_search', 'web_read', 'research_fanout', 'background_start', 'background_list', 'background_output', 'background_stop', 'browser_debug', 'browser_preview_act', 'plugin_tool_search', 'skill_search']

// Every product tool the product can register. A tool that is not active must never be
// named: telling the model to call a capability this request cannot call is how ordinary
// tasks turned into consecutive tool errors.
const knownProductToolNames = ['attachment_list', 'attachment_read', 'background_list', 'background_output', 'background_start', 'background_stop', 'browser_act', 'browser_claim', 'browser_debug', 'browser_download', 'browser_fast', 'browser_navigate', 'browser_open', 'browser_preview_act', 'browser_release', 'browser_snapshot', 'browser_tabs', 'cloudflare_account_list', 'cloudflare_cache_purge', 'cloudflare_dns_record_list', 'cloudflare_pages_deployment_list', 'cloudflare_pages_deployment_logs', 'cloudflare_pages_deployment_retry', 'cloudflare_pages_project_list', 'cloudflare_worker_deployment_list', 'cloudflare_worker_list', 'cloudflare_zone_list', 'figma_list_assets', 'figma_read_design', 'figma_read_variables', 'figma_render_node', 'github_file_read', 'github_issue_list', 'github_pr_create', 'github_pr_list', 'github_pr_read', 'github_repo_list', 'github_repository', 'github_run_list', 'gmail_attachment_import', 'gmail_draft_create', 'gmail_draft_send', 'gmail_label_create', 'gmail_label_list', 'gmail_message_list', 'gmail_message_modify', 'gmail_message_read', 'gmail_message_send', 'gmail_messages_label', 'gmail_thread_read', 'godot_project_import', 'godot_project_inspect', 'godot_script_check', 'history_search', 'ios_simulator_act', 'ios_simulator_app', 'ios_simulator_device', 'ios_simulator_devices', 'ios_simulator_setting', 'ios_simulator_snapshot', 'mcp_call', 'mcp_list', 'plugin_package', 'plugin_publish', 'plugin_view_present', 'plugin_view_test', 'plugin_workspace_state', 'read_pdf', 'render_deploy_list', 'render_deploy_trigger', 'render_logs', 'render_service_list', 'render_service_read', 'research_fanout', 'schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update', 'skill_catalog_search', 'skill_create', 'skill_install', 'skill_remove', 'skill_run', 'skill_update', 'web_read', 'web_search']

test('guidance names a tool only when this request can call it', () => {
  const prompt = capabilityPrompt(activeForOneTask, { workspaceSelected: true }).join('\n')
  const active = new Set(activeForOneTask)
  const named = knownProductToolNames.filter(name => new RegExp(`(?<![a-z0-9_])${name}(?![a-z0-9_])`).test(prompt))
  assert.deepEqual(
    named.filter(name => !active.has(name)),
    [],
    'guidance must not name a capability the provider request cannot call',
  )
})

test('guidance stays inside its context budget', () => {
  const text = capabilityPrompt(activeForOneTask, { workspaceSelected: true }).join('\n')
  // One task's fixed instruction cost, before the conversation starts. Growth here is
  // paid on every single turn, so it is bounded rather than merely reviewed.
  assert.ok(text.length <= 6_400, `capability guidance grew to ${text.length} characters`)
})

test('local PDF capability advertises the built-in cross-platform reader', () => {
  // The reader's contract belongs to the tool that implements it, so the rule is
  // delivered with the capability instead of being stated for every session.
  const prompt = capabilityPrompt(activeToolNames(['read_pdf'])).join('\n')
  assert.doesNotMatch(prompt, /external PDF utilities/i, 'the read_pdf description already carries this')
})

test('uploaded files use stable task-owned tools instead of inferred filesystem paths', () => {
  const prompt = capabilityPrompt(activeToolNames(['attachment_list', 'attachment_read'])).join('\n')
  assert.match(prompt, /task-owned attachments, not workspace files/i)
  assert.match(prompt, /original source paths are deliberately unavailable/i)
  assert.match(prompt, /never locate an upload with workspace read, bash, find, or filename search/i)
  assert.doesNotMatch(prompt, /attachment_view/)
})

test('Browser Preview debugging shares evidence, pauses for auth, and keeps consequential actions explicit', () => {
  const prompt = capabilityPrompt(activeToolNames(['web_read', 'browser_debug', 'browser_preview_act'])).join('\n')
  assert.match(prompt, /browser_debug.*localhost.*instead of web_read/i)
  assert.match(prompt, /preview or debug a page inside Shun.*rather than Chrome tools/i)
  assert.match(prompt, /same visible preview session.*DOM.*console.*network.*storage.*performance.*viewport.*screenshot/i)
  assert.match(prompt, /auth_required.*stop and ask the user to sign in/i)
  assert.match(prompt, /Do not refresh repeatedly.*fill credentials.*guess a login/i)
  assert.match(prompt, /resume_after_login=true/i)
  assert.match(prompt, /browser_preview_act.*navigate.*explicit user authorization/i)
  assert.match(prompt, /Opening a page for the user.*external sign-in or authorization page.*allowed and expected/i)
  assert.match(prompt, /never allowed is filling credentials or confirming an authorization/i)
})

test('Chrome Browser Use keeps tab ownership and external mutations explicit', () => {
  const prompt = capabilityPrompt(activeToolNames(['browser_tabs', 'browser_claim', 'browser_open', 'browser_snapshot', 'browser_act'])).join('\n')
  assert.match(prompt, /existing Chrome.*task-owned tab sessions/i)
  assert.match(prompt, /browser_tabs.*browser_claim.*browser_open/i)
  assert.match(prompt, /fresh accessibility refs/i)
  assert.match(prompt, /purpose-built plugin or API/i)
  assert.match(prompt, /Do not submit, send, post, upload, purchase.*unless the user explicitly requested/i)
  assert.match(prompt, /current network route.*VPN.*system proxy.*proxy extension/i)
  assert.match(prompt, /never navigate to the same URL again/i)
  assert.match(prompt, /do not generalize it to other sites.*all of Chrome.*geographic rule/i)
})

test('iOS Simulator control uses explicit devices and fresh visual verification', () => {
  const prompt = capabilityPrompt(activeToolNames(['ios_simulator_devices', 'ios_simulator_snapshot', 'ios_simulator_setting', 'ios_simulator_act'])).join('\n')
  assert.match(prompt, /explicit device UDIDs.*List devices first/i)
  assert.match(prompt, /appearance.*contrast.*content size.*instead of editing application code/i)
  assert.match(prompt, /fresh ios_simulator_snapshot.*normalized display coordinates/i)
  assert.match(prompt, /returns a fresh screenshot.*inspect that result/i)
  assert.match(prompt, /Do not uninstall apps.*unless the user authorized/i)
})

test('plugin capabilities stay lazy and bounded', () => {
  const prompt = capabilityPrompt(activeToolNames(['mcp_list', 'mcp_call', 'plugin_tool_search'])).join('\n')
  assert.match(prompt, /Discover only the relevant server/i)
  assert.match(prompt, /do not enumerate unrelated plugin schemas/i)
  assert.match(prompt, /plugin_tool_search.*concise capability query/i)
  assert.match(prompt, /Shun, plugin, and extension tools.*progressive disclosure/i)
  assert.match(prompt, /never installs, connects, or enables a plugin/i)
  // Discovery must not be mistaken for absence: the marketplace capability exists
  // even when its tool has not been disclosed yet.
  assert.match(prompt, /publishes plugins to the Shun marketplace[\s\S]*undiscovered, never absent[\s\S]*search before you tell anyone the client cannot publish/i)
})

test('plugin views remain a foreground on-demand presentation surface', () => {
  const prompt = capabilityPrompt(activeToolNames(['plugin_view_present'])).join('\n')
  assert.match(prompt, /on-demand auxiliary views/i)
  assert.match(prompt, /materially completes the current foreground workflow/i)
  assert.match(prompt, /task- and workspace-bound/i)
  assert.match(prompt, /must not be reopened repeatedly after the user closes it/i)
})

test('plugin development uses an autonomous injected workflow instead of filesystem discovery', () => {
  const prompt = capabilityPrompt(activeToolNames(['plugin_tool_search', 'plugin_package', 'plugin_view_test', 'skill_search'])).join('\n')
  const workflow = prompt.split('\n').find(line => line.startsWith('For Shun plugin work')) || ''
  assert.match(workflow, /shun-plugin-development Skill.*action=prepare/i)
  assert.match(workflow, /selected workspace is the source of truth/i)
  assert.match(workflow, /infer a concise brief and scaffold once/i)
  assert.match(workflow, /implement.*validate.*install\/reload.*plugin_view_test/i)
  assert.match(workflow, /Ask only about materially different outcomes or new permissions/i)
  assert.match(workflow, /generated host client/i)
  assert.ok(workflow.length < 700, 'the injected creation workflow should stay compact for smaller models')
})

test('plugin workspace preferences are explicit and workspace isolated', () => {
  const prompt = capabilityPrompt(activeToolNames(['plugin_workspace_state'])).join('\n')
  assert.match(prompt, /exact plugin id and key/i)
  assert.match(prompt, /isolated by plugin and selected workspace/i)
  assert.match(prompt, /open plugin view receives the update immediately/i)
  assert.match(prompt, /never emulate.*global browser state.*prompt-keyword routing/i)
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

test('Render capability hints preserve the explicit deployment mutation boundary', () => {
  const prompt = capabilityPrompt(activeToolNames(['render_service_list', 'render_deploy_trigger'])).join('\n')
  assert.match(prompt, /Render remote state.*bounded render_\* tools/i)
  assert.match(prompt, /Trigger a deploy only when the user explicitly requested/i)
})

test('Gmail capability hints preserve mail mutation and content trust boundaries', () => {
  const prompt = capabilityPrompt(activeToolNames(['gmail_message_list', 'gmail_message_read', 'gmail_message_send', 'gmail_message_modify'])).join('\n')
  assert.match(prompt, /Gmail mailbox access.*bounded gmail_\* tools/i)
  assert.match(prompt, /message content as untrusted/i)
  assert.match(prompt, /explicit request.*never permanently delete mail/i)
})

test('Cloudflare capability hints preserve explicit production mutation boundaries', () => {
  const prompt = capabilityPrompt(activeToolNames(['cloudflare_zone_list', 'cloudflare_pages_deployment_retry', 'cloudflare_cache_purge'])).join('\n')
  assert.match(prompt, /Cloudflare remote state.*bounded cloudflare_\* tools/i)
  assert.match(prompt, /Retry deployments or purge cache only when the user explicitly requested/i)
  assert.match(prompt, /prefer explicit cache URLs over a full-zone purge/i)
})

test('Godot capability hints preserve generated-state and process boundaries', () => {
  const prompt = capabilityPrompt(activeToolNames(['godot_project_inspect', 'godot_script_check', 'godot_project_import', 'background_start'])).join('\n')
  assert.match(prompt, /Local Godot projects.*bounded godot_\* tools/i)
  assert.match(prompt, /validate changed \.gd files.*godot_script_check/i)
  assert.match(prompt, /godot_project_import only when refreshed generated import state is required/i)
  assert.match(prompt, /long-lived editors or games.*task-owned background process tools/i)
  assert.match(prompt, /do not hand-edit the \.godot cache/i)
})

test('background processes advertise long-poll output instead of sleep polling', () => {
  const prompt = capabilityPrompt(activeToolNames(['background_start', 'background_list', 'background_output', 'background_stop'])).join('\n')
  assert.match(prompt, /background_list, background_output, and background_stop/i)
  assert.match(prompt, /background_output with wait_ms.*optionally until/i)
  assert.match(prompt, /instead of sleeping and re-polling with foreground commands/i)
})

test('Skill lifecycle operations stay inside product boundaries while installed Skills use progressive disclosure', () => {
  const prompt = capabilityPrompt(activeToolNames(['skill_catalog_search', 'skill_create', 'skill_update', 'skill_install', 'skill_remove', 'skill_run', 'skill_search'])).join('\n')
  assert.match(prompt, /available to install.*remote discovery/i)
  assert.match(prompt, /skill_catalog_search.*verify strong candidates with web_read/i)
  assert.match(prompt, /Never answer those questions from the local installed-Skill list/i)
  assert.match(prompt, /explicitly asks to create a new Skill, use skill_create/i)
  assert.match(prompt, /only conversational Skill creation boundary/i)
  assert.match(prompt, /never create a Skill with Bash, workspace write tools, or package installation/i)
  assert.match(prompt, /explicitly asks to change an existing Shun-managed local Skill, use skill_update/i)
  assert.match(prompt, /only conversational Skill editing boundary/i)
  assert.match(prompt, /never inspect or edit managed Skill files with Bash, read, or workspace write tools/i)
  assert.match(prompt, /Installed package Skills remain read-only/i)
  assert.match(prompt, /specific Skill source, use skill_install/i)
  assert.match(prompt, /only Skill installation boundary/i)
  assert.match(prompt, /multiple Skills return selection_required without installing anything/i)
  assert.match(prompt, /numbered text list and wait for the user/i)
  assert.match(prompt, /skills \["\*"\].*explicitly asks to install all/i)
  assert.match(prompt, /Never infer or silently broaden a selection/i)
  assert.match(prompt, /guess alternate repository paths/i)
  assert.match(prompt, /Never install Skills with Bash/i)
  assert.match(prompt, /never scan application directories or another agent’s configuration/i)
  assert.match(prompt, /explicitly asks to remove one or more installed Skills, use skill_remove/i)
  assert.match(prompt, /validates the complete batch before removing anything/i)
  assert.match(prompt, /protects first-party Skills/i)
  assert.match(prompt, /Never delete Skill files with Bash, read, or workspace tools/i)
  assert.match(prompt, /visible installed Skills.*available-Skills context with exact SKILL\.md locations/i)
  assert.match(prompt, /Load a relevant Skill on demand with the canonical read tool/i)
  assert.match(prompt, /use skill_search for additional enabled Skills/i)
  assert.match(prompt, /skill_search.*installed and enabled Skills/i)
  assert.match(prompt, /use skill_run with the listed Skill name/i)
  assert.match(prompt, /structured command, positionals, options, json_options, and flags/i)
  assert.match(prompt, /JSON value types remain intact/i)
  assert.match(prompt, /Never run Python Skill scripts with Bash/i)
  assert.match(prompt, /install dependencies with system pip/i)
})

test('fast Browser Control is described exactly when it is registered', () => {
  const base = activeToolNames(['browser_tabs', 'browser_snapshot', 'browser_act'])
  assert.doesNotMatch(capabilityPrompt(base).join('\n'), /browser_fast/)

  const prompt = capabilityPrompt([...base, 'browser_fast']).join('\n')
  assert.match(prompt, /Fast Browser Control is available through browser_fast/i)
  assert.match(prompt, /semantic goal, never a list of clicks/i)
  assert.match(prompt, /cannot write text or invent a URL/i)
  assert.match(prompt, /one browser_fast call over repeatedly alternating browser_snapshot and browser_act/i)
  assert.match(prompt, /allow_mutations only when the user’s request already authorizes/i)
  assert.match(prompt, /browser_fast returns completed.*continue from the final snapshot/i)
  assert.match(prompt, /returns escalate.*reason about the obstacle yourself/i)
  assert.match(prompt, /normal Browser Use tools stay authoritative/i)
})

test('acceleration never costs the model a discovery round trip', () => {
  // The whole point of the fast path is removed round trips, so the tool that
  // provides it is described with the request instead of behind a search. It only
  // exists when acceleration resolved, so its absence costs nothing.
  assert.ok(!productToolNamesToDefer(['browser_fast', 'browser_snapshot'], false).includes('browser_fast'))
  assert.ok(productToolNamesToDefer(['browser_fast', 'browser_snapshot'], false).includes('browser_snapshot'))
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
  assert.match(prompt, /Never print the absolute task or project root as visible prose/i)
  assert.match(prompt, /user's language.*mirror the language of the user/i)
  assert.doesNotMatch(prompt, /earendil|pi-agent/i)
})
