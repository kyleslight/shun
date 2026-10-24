import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { parseHTML } from 'linkedom'

for (const name of ['service-worker.js', 'fast-path.js']) {
  test(`${name} distinguishes upload siblings from unrelated dialog actions`, async () => {
    const source = await readFile(new URL(`../../resources/browser-use-extension/${name}`, import.meta.url), 'utf8')
    const resolver = source.match(/function fileInputFor\(node\) \{[\s\S]*?\n  \}/)?.[0]
    assert.ok(resolver, 'exercise the actual shipped page resolver')
    const { document } = parseHTML(`<html><body>
      <div><button id="proxy">Choose</button><input id="file" type="file"></div>
      <div role="dialog"><input type="file"><button id="cancel">Cancel</button><button id="logout">Log out</button></div>
      <div><div><input type="file"></div><button id="continue">Continue</button></div>
      <label><input id="label-file" type="file"><span id="label-proxy">Choose</span></label>
    </body></html>`)
    const find = vm.runInNewContext(`(${resolver})`, { document })
    assert.equal(find(document.getElementById('proxy')), document.getElementById('file'))
    assert.equal(find(document.getElementById('label-proxy')), document.getElementById('label-file'))
    for (const id of ['cancel', 'logout', 'continue']) assert.equal(find(document.getElementById(id)), null, id)
  })
}
