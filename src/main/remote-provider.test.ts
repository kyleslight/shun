import assert from 'node:assert/strict'
import test from 'node:test'
import { remoteProviders, saveRemoteProvider, selectRemoteProvider } from '../remote-provider.ts'
import type { Settings } from '../shared.ts'

function settings(): Settings {
  return {
    endpoint: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    providerId: 'local',
    providers: [
      {
        id: 'local',
        name: 'Local',
        kind: 'ollama',
        endpoint: 'http://127.0.0.1:11434/v1',
        apiKey: '',
        contextWindow: 32_768,
        models: [{ id: 'llama3', contextWindow: 32_768, maxOutputTokens: 4_096 }],
      },
      {
        id: 'cloud',
        name: 'Cloud',
        kind: 'cloud',
        endpoint: 'https://api.example.com/v1',
        apiKey: 'sk-secret',
        contextWindow: 200_000,
        models: [{ id: 'gpt-5', contextWindow: 200_000, maxOutputTokens: 32_000 }],
      },
    ],
    model: 'llama3',
    workspace: '/tmp',
    temperature: 0.2,
    maxTokens: 4_096,
    contextWindow: 32_768,
    autoCompact: true,
  }
}

test('a provider reaches a phone without its key', () => {
  const [local, cloud] = remoteProviders(settings())
  assert.equal(local.hasApiKey, false)
  assert.equal(cloud.hasApiKey, true)
  assert.equal('apiKey' in cloud, false)
  assert.equal(cloud.models[0].contextWindow, 200_000)
})

test('selecting a provider keeps its model when that provider serves it', () => {
  const before = { ...settings(), model: 'gpt-5', contextWindow: 200_000 }
  const after = selectRemoteProvider(before, 'local')
  assert.equal(after?.providerId, 'local')
  assert.equal(after?.model, 'llama3')
  assert.equal(after?.contextWindow, 32_768)
  assert.equal(after?.maxTokens, 4_096)
})

test('selecting a provider this machine does not have changes nothing', () => {
  assert.equal(selectRemoteProvider(settings(), 'gone'), undefined)
})

test('editing the active provider moves the connection it runs with', () => {
  const after = saveRemoteProvider(settings(), {
    id: 'local',
    name: 'Local models',
    endpoint: 'http://127.0.0.1:8000/v1',
    apiKey: 'sk-new',
  })
  assert.equal(after?.providers[0].name, 'Local models')
  assert.equal(after?.endpoint, 'http://127.0.0.1:8000/v1')
  assert.equal(after?.apiKey, 'sk-new')
  assert.equal(after?.providers[1].endpoint, 'https://api.example.com/v1')
})

test('a key left out of an edit is the key that was there', () => {
  const after = saveRemoteProvider(settings(), { id: 'cloud', name: 'Cloud models' })
  assert.equal(after?.providers[1].apiKey, 'sk-secret')
})

test('an empty endpoint is not a connection', () => {
  assert.equal(saveRemoteProvider(settings(), { id: 'local', endpoint: '   ' }), undefined)
})
