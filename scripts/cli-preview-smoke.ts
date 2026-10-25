import {mkdtemp, mkdir, symlink, rm} from 'node:fs/promises'
import {tmpdir, homedir} from 'node:os'
import {join} from 'node:path'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { HostBrowserPreview } from '../src/host/browser-preview.ts'
const server = createServer((_req,res)=>res.end('<title>Preview fixture</title><input aria-label="Name"><button onclick="document.querySelector(\'p\').textContent=document.querySelector(\'input\').value">Apply</button><p>Before</p><script>console.log("fixture ready")</script>'))
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
const root=await mkdtemp(join(tmpdir(),'shun-preview-smoke-'))
const cache=join(homedir(),'.shun','browsers')
await mkdir(cache,{recursive:true})
await symlink(cache,join(root,'browsers'))
const preview = new HostBrowserPreview(root)
try {
 const url = `http://127.0.0.1:${(server.address() as any).port}`
 const first = await preview.inspect('isolated-smoke',{url,screenshot:true})
 assert.match(first.content[0].text!,/Preview fixture/)
 assert.ok(first.content.some(item=>item.type==='image'))
 const filled = await preview.act('isolated-smoke',{type:'fill',ref:JSON.parse(first.content[0].text!).controls[0].ref,value:'After'})
 const last = await preview.act('isolated-smoke',{type:'click',ref:JSON.parse(filled.content[0].text!).controls[1].ref})
 assert.match(last.content[0].text!,/After/)
 console.log('PASS: managed headless preview, DOM, screenshot, console, network, fill and click.')
} finally {await preview.close();server.close();await rm(root,{recursive:true,force:true})}
