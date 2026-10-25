import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capabilityDirectory } from './capability-modules.ts'

test('optional capabilities install on demand once, atomically, and reuse their cache', async () => {
 const root = await mkdtemp(join(tmpdir(), 'shun-capability-test-'))
 let calls = 0
 const install = async (_directory: string, packages: readonly string[]) => { calls++; assert.ok(packages.includes('puppeteer-core@25.16.0')); await new Promise(resolve => setTimeout(resolve, 10)) }
 try {
  assert.deepEqual(await readdir(root), [])
  const [a,b] = await Promise.all([capabilityDirectory('puppeteer-core',root,install), capabilityDirectory('@puppeteer/browsers',root,install)])
  assert.equal(a,b); assert.equal(calls,1)
  assert.equal(await capabilityDirectory('puppeteer-core',root,install),a)
  assert.equal(calls,1); assert.ok(!(await readdir(root)).some(name=>name.startsWith('.install-')))
 } finally { await rm(root,{recursive:true,force:true}) }
})
test('failed capability setup leaves no ready cache and can be retried', async () => {
 const root = await mkdtemp(join(tmpdir(), 'shun-capability-retry-'))
 try {
  await assert.rejects(capabilityDirectory('@napi-rs/canvas',root,async()=>{throw Error('offline')}), /offline/)
  assert.deepEqual(await readdir(root),[])
  const path = await capabilityDirectory('@napi-rs/canvas',root,async()=>{})
  assert.ok((await readdir(path)).includes('.ready'))
 } finally { await rm(root,{recursive:true,force:true}) }
})
