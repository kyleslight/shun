import assert from 'node:assert/strict'
import test from 'node:test'
import { toolNeedsApproval } from './permissions.ts'

test('authorization depends only on explicit permission mode and tool identity', () => {
  for (const name of ['bash', 'edit', 'write', 'mcp_call']) {
    assert.equal(toolNeedsApproval('ask', name), true)
    assert.equal(toolNeedsApproval('workspace', name), false)
  }
  assert.equal(toolNeedsApproval('ask', 'read'), false)
  assert.equal(toolNeedsApproval('ask', 'web_search'), false)
})
