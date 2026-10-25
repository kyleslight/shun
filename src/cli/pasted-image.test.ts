import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pastedImage } from './pasted-image.ts'

test('terminal image paths become attachments while normal pasted text stays text', async () => {
 const root = await mkdtemp(join(tmpdir(), 'shun-paste-'))
 try {
  const path = join(root, 'Screenshot 1.png')
  await writeFile(path, Buffer.from([137,80,78,71]))
  for (const text of [path, `"${path}"`, `'${path}'`, path.replaceAll(' ', '\\ '), pathToFileURL(path).href]) {
   assert.equal((await pastedImage(text))?.name, 'Screenshot 1.png')
  }
  assert.equal(await pastedImage('ordinary text'), undefined)
  assert.equal(await pastedImage('please inspect ' + path), undefined)
  assert.equal(await pastedImage('/missing/image.png'), undefined)
 } finally { await rm(root,{recursive:true,force:true}) }
})
