import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import test from 'node:test'
import {PluginPackageRegistry,validatePluginPackage} from './plugin-packages.ts'
import {packageAgentTools} from './plugin-tools.ts'
import type {Settings} from '../shared.ts'

test('package APIs are directly callable without a workspace and honor enablement and permission changes', async()=>{
 const root=await mkdtemp(join(tmpdir(),'shun-package-api-')),source=join(root,'source');await mkdir(source)
 const manifest={schemaVersion:1,id:'inventory',name:'Inventory',description:'Inventory account.',version:'1.0.0',publisher:'Test',permissions:[{id:'workspace.process',reason:'Call API.'}],contributes:{workers:[{id:'api',entry:'api.mjs',timeoutMs:2000}],tools:[{id:'api',title:'Inventory API',description:'Read inventory directly.',worker:'api'}]}}
 await writeFile(join(source,'manifest.json'),JSON.stringify(manifest));await writeFile(join(source,'api.mjs'),'')
 const registry=new PluginPackageRegistry(join(root,'bundled'),join(root,'installed'));await registry.refresh();await registry.installFromDirectory(source)
 const settings={plugins:[{id:'inventory',enabled:true,permissions:['workspace.process']}]} as Settings
 const calls: unknown[]=[];const invoke=async(...args:unknown[])=>{calls.push(args);return {items:3}}
 const tools=packageAgentTools(registry,settings,new Set(['inventory']),'',invoke)
 assert.equal(tools.length,1);assert.equal(tools[0].name,'plugin_inventory_api')
 await tools[0].execute('call',{operation:'list'},undefined,undefined,{} as any)
 assert.deepEqual(calls,[['inventory','api',{operation:'list',input:{}}]])
 settings.plugins![0].permissions=[]
 assert.equal(packageAgentTools(registry,settings,new Set(['inventory']),'',invoke).length,0)
 await assert.rejects(()=>tools[0].execute('call',{operation:'list'},undefined,undefined,{} as any),/no longer available/)
 settings.plugins![0].permissions=['workspace.process'];settings.plugins![0].enabled=false
 assert.equal(packageAgentTools(registry,settings,new Set(['inventory']),'',invoke).length,0)
 settings.plugins![0].enabled=true
 assert.equal(packageAgentTools(registry,settings,new Set(),'',invoke).length,0)
 assert.throws(()=>validatePluginPackage({...manifest,contributes:{...manifest.contributes,tools:[{...manifest.contributes.tools[0],worker:'missing'}]}}),/declared worker/)
})
