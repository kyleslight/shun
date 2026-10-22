import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
let pendingListeners: Promise<Map<number, number[]>> | undefined

function listeners() {
  // Share only an in-flight OS read across concurrent resources; no stale cache.
  return pendingListeners ??= (async () => {
    let stdout = ''
    try { stdout = (await run('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-Fpgn'], { timeout: 2_000, maxBuffer: 1_048_576 })).stdout }
    catch (error: any) { if (!(error.code === 1 && !error.stdout && !error.stderr)) throw error }
    const result = new Map<number, number[]>()
    let group = 0
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) group = 0
      if (line.startsWith('g')) group = Number(line.slice(1))
      const port = line.startsWith('n') && /:(\d+)$/.exec(line)
      if (port) { const number = Number(port[1]); result.set(number, [...(result.get(number) || []), group]) }
    }
    return result
  })().finally(() => { pendingListeners = undefined })
}

/** Socket ownership comes from the OS, never from a command or a printed URL. */
export async function localEndpointStatus(url: string, groupId?: number): Promise<{ listening: boolean; owned: boolean }> {
  const target = new URL(url)
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
  if (process.platform === 'win32') {
    const script = `$ids=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess); $all=@{}; Get-CimInstance Win32_Process | ForEach-Object {$all[[int]$_.ProcessId]=[int]$_.ParentProcessId}; $owned=($ids.Count -gt 0); foreach($id in $ids){$found=$false; $seen=@{}; while($id -and !$seen.ContainsKey([int]$id)) {if($id -eq ${groupId || 0}){$found=$true;break}; $seen[[int]$id]=$true; $id=$all[[int]$id]}; if(!$found){$owned=$false}}; @{listening=($ids.Count -gt 0);owned=$owned} | ConvertTo-Json -Compress`
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 3_000, maxBuffer: 1_048_576, windowsHide: true })
    return JSON.parse(stdout)
  }
  try {
    const groups = (await listeners()).get(port) || []
    return { listening: groups.length > 0, owned: Boolean(groupId && groups.length && groups.every(group => group === groupId)) }
  } catch (error: any) {
    if (error.code === 1 && !error.stdout && !error.stderr) return { listening: false, owned: false }
    throw Error('Shun could not verify which process owns the preview port.', { cause: error })
  }
}
