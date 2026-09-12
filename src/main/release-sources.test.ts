import assert from 'node:assert/strict'
import test from 'node:test'
import { digestForFile, parseChecksums, releaseAssetNames, releaseSources, releaseTagBase, selectReleaseSource, updateMetadataFile, type ReleaseProbe } from './release-sources.ts'

const metadata = [
  'version: 0.1.32',
  'files:',
  '  - url: Shun-Setup-0.1.32-x64.exe',
  '    sha512: abc',
  '    size: 138000000',
  'path: Shun-Setup-0.1.32-x64.exe',
  'sha512: abc',
  '',
].join('\n')

const sources = releaseSources({ owner: 'kyleslight', repo: 'shun' })

function probeStub(behaviour: Record<string, { latency?: number; speed?: number; misses?: boolean }>, pool = sources) {
  const calls: string[] = []
  const owner = (url: string) => pool.find(source => url.startsWith(source.base))?.id
  const probe: ReleaseProbe = {
    async text(url) {
      calls.push(`text ${url}`)
      const entry = behaviour[owner(url) ?? '']
      if (!entry || entry.misses) throw Error('unreachable')
      return { body: metadata, elapsedMs: entry.latency ?? 100 }
    },
    async throughput(url, bytes) {
      calls.push(`throughput ${url}`)
      const entry = behaviour[owner(url) ?? '']
      if (!entry || entry.misses || entry.speed === undefined) throw Error('unreachable')
      return { bytes, bytesPerSecond: entry.speed, latencyMs: entry.latency ?? 100 }
    },
  }
  return { probe, calls }
}

test('release sources cover the direct release path, mirrors, and an optional official base', () => {
  assert.deepEqual(sources.map(source => [source.id, source.kind, source.base]), [
    ['github', 'direct', 'https://github.com/kyleslight/shun/releases/latest/download/'],
    ['gh-proxy.com', 'mirror', 'https://gh-proxy.com/https://github.com/kyleslight/shun/releases/latest/download/'],
    ['ghfast.top', 'mirror', 'https://ghfast.top/https://github.com/kyleslight/shun/releases/latest/download/'],
    ['ghproxy.net', 'mirror', 'https://ghproxy.net/https://github.com/kyleslight/shun/releases/latest/download/'],
  ])
  const hosted = releaseSources({ owner: 'kyleslight', repo: 'shun', officialBase: 'https://dl.example.com/shun' })
  assert.deepEqual(hosted[0], { id: 'official', label: 'dl.example.com', kind: 'official', base: 'https://dl.example.com/shun/' })
  assert.equal(updateMetadataFile('win32'), 'latest.yml')
  assert.equal(updateMetadataFile('darwin'), 'latest-mac.yml')
  assert.equal(updateMetadataFile('linux'), 'latest-linux.yml')
  assert.deepEqual(releaseAssetNames(metadata), ['Shun-Setup-0.1.32-x64.exe'])
})

test('the fastest reachable release source wins, and mirrors are only used when they help', async () => {
  const asset = `${sources[0].base}${releaseAssetNames(metadata)[0]}`
  const mirrorAsset = `${sources[1].base}${releaseAssetNames(metadata)[0]}`

  const fast = probeStub({ github: { speed: 3_000_000 }, 'gh-proxy.com': { speed: 1_000_000 } })
  const preferred = await selectReleaseSource({ sources: sources.slice(0, 2), metadataFile: 'latest.yml', probe: fast.probe })
  assert.equal(preferred?.source.id, 'github')
  assert.match(fast.calls[0], /^text https:\/\/github\.com/)
  assert.deepEqual(fast.calls.includes(`throughput ${asset}`), true)
  assert.deepEqual(fast.calls.includes(`throughput ${mirrorAsset}`), true)

  const blocked = probeStub({ github: { misses: true }, 'gh-proxy.com': { speed: 400_000 } })
  const mirrored = await selectReleaseSource({ sources: sources.slice(0, 2), metadataFile: 'latest.yml', probe: blocked.probe })
  assert.equal(mirrored?.source.id, 'gh-proxy.com')
  assert.equal(mirrored?.sources.length, 1, 'the unreachable source is not offered again')

  const throttled = probeStub({ github: { speed: 120_000, latency: 40 }, 'gh-proxy.com': { speed: 2_500_000, latency: 900 } })
  const switched = await selectReleaseSource({ sources: sources.slice(0, 2), metadataFile: 'latest.yml', probe: throttled.probe })
  assert.equal(switched?.source.id, 'gh-proxy.com', 'a throttled GitHub is left behind')
  assert.equal(switched?.bytesPerSecond, 2_500_000)

  const official = probeStub({ github: { speed: 500_000 }, 'gh-proxy.com': { speed: 1_800_000 } })
  const withOfficial = await selectReleaseSource({
    sources: [releaseSources({ owner: 'kyleslight', repo: 'shun', officialBase: 'https://dl.example.com/shun' })[0], ...sources.slice(0, 2)],
    metadataFile: 'latest.yml',
    probe: official.probe,
  })
  assert.equal(withOfficial?.source.kind, 'mirror', 'a much faster mirror still wins')

  const hosted = probeStub({ official: { speed: 2_400_000 }, 'gh-proxy.com': { speed: 1_800_000 } }, releaseSources({ owner: 'kyleslight', repo: 'shun', officialBase: 'https://dl.example.com/shun' }))
  const selfHosted = await selectReleaseSource({
    sources: [releaseSources({ owner: 'kyleslight', repo: 'shun', officialBase: 'https://dl.example.com/shun' })[0], sources[1]],
    metadataFile: 'latest.yml',
    probe: hosted.probe,
  })
  assert.equal(selfHosted?.source.kind, 'official')
})

test('an unmeasurable but reachable release source is kept instead of guessing', async () => {
  const unmeasurable = probeStub({ github: { latency: 200 }, 'gh-proxy.com': { misses: true } })
  const selection = await selectReleaseSource({ sources: sources.slice(0, 2), metadataFile: 'latest.yml', probe: unmeasurable.probe })
  assert.equal(selection?.source.id, 'github')
  assert.deepEqual(selection?.sources.map(source => source.id), ['github'])

  const none = probeStub({ github: { misses: true }, 'gh-proxy.com': { misses: true } })
  assert.equal(await selectReleaseSource({ sources: sources.slice(0, 2), metadataFile: 'latest.yml', probe: none.probe }), undefined)
  assert.equal(await selectReleaseSource({ sources: [], metadataFile: 'latest.yml', probe: none.probe }), undefined)
})

test('a metadata-only check stays cheap and prefers the reachable hosted copy', async () => {
  const cheap = probeStub({ github: { latency: 900 }, 'gh-proxy.com': { latency: 120 } })
  const selection = await selectReleaseSource({ sources: sources.slice(0, 2), metadataFile: 'latest.yml', probe: cheap.probe, measureThroughput: false })
  assert.equal(selection?.source.id, 'github', 'without measurements the directly hosted copy is kept')
  assert.deepEqual(cheap.calls.filter(call => call.startsWith('throughput')), [])

  const throttled = probeStub({ github: { misses: true }, 'gh-proxy.com': { latency: 120 } })
  const mirrored = await selectReleaseSource({ sources: sources.slice(0, 2), metadataFile: 'latest.yml', probe: throttled.probe, measureThroughput: false })
  assert.equal(mirrored?.source.id, 'gh-proxy.com')
})

test('a mirrored package can be checked against the release checksums of its own tag', () => {
  const direct = sources[0]
  const mirror = sources[1]
  assert.equal(
    releaseTagBase(mirror, '0.1.32'),
    'https://gh-proxy.com/https://github.com/kyleslight/shun/releases/download/v0.1.32/',
  )
  assert.equal(releaseTagBase(direct, '0.1.33'), 'https://github.com/kyleslight/shun/releases/download/v0.1.33/')
  const digests = parseChecksums([
    'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef0123456789abcdef01  Shun-Setup-0.1.32-x64.exe',
    'B1B2C3D4E5F60718293A4B5C6D7E8F9012345678ABCDEF0123456789ABCDEF02  *Shun-0.1.32-arm64.dmg',
    'not a checksum line',
  ].join('\n'))
  assert.equal(digests.get('Shun-Setup-0.1.32-x64.exe'), 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef0123456789abcdef01')
  assert.equal(digests.get('Shun-0.1.32-arm64.dmg'), 'b1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef0123456789abcdef02')
  assert.equal(digests.size, 2)
})

test('a package name matches its published checksum through the platform prefix', () => {
  const digests = parseChecksums([
    '5927f9134cec0aace9b84687e5074657b6f83a88e191e23404eea1e5408b0fa7  macos/Shun-0.1.32-arm64-mac.zip.blockmap',
    'bbd7c1e6472a7e82cab66ece4ddeb7a4cb584d63863a4ab153287d61421c74e0  windows/latest.yml',
  ].join('\n'))
  assert.equal(
    digestForFile(digests, 'Shun-0.1.32-arm64-mac.zip.blockmap'),
    '5927f9134cec0aace9b84687e5074657b6f83a88e191e23404eea1e5408b0fa7',
  )
  assert.equal(digestForFile(digests, 'latest.yml'), 'bbd7c1e6472a7e82cab66ece4ddeb7a4cb584d63863a4ab153287d61421c74e0')
  assert.equal(digestForFile(digests, 'Shun-Setup-0.1.33-x64.exe'), undefined)
})
