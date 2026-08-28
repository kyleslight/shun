const PORTS = Array.from({ length: 10 }, (_, index) => 32124 + index)
const stateNode = document.getElementById('state')
const labelNode = document.getElementById('label')
const detailNode = document.getElementById('detail')
const connectButton = document.getElementById('connect')
let connecting = false

function render(kind, label, detail) {
  stateNode.classList.toggle('connected', kind === 'connected')
  stateNode.classList.toggle('connecting', kind === 'connecting')
  stateNode.classList.toggle('error', kind === 'error')
  labelNode.textContent = label
  detailNode.textContent = detail
  connectButton.hidden = kind === 'connected'
  connectButton.disabled = kind === 'connecting'
}

function sendMessage(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
    const error = chrome.runtime.lastError
    if (error) reject(new Error(error.message))
    else resolve(response)
  }))
}

async function refreshStatus() {
  try {
    const response = await sendMessage({ type: 'status' })
    if (response?.connected) {
      const count = response.attachedTabs || 0
      render('connected', 'Connected to Shun', `${count} controlled tab${count === 1 ? '' : 's'}`)
      return true
    }
  } catch {}
  if (!connecting) render('idle', 'Connection required', 'Keep Shun open, then connect to allow local network access.')
  return false
}

function probePort(port) {
  return new Promise((resolve, reject) => {
    const candidate = new WebSocket(`ws://127.0.0.1:${port}/permission-probe`)
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(port)
    }
    const timer = setTimeout(() => {
      try { candidate.close() } catch {}
      finish(new Error('Connection timed out.'))
    }, 20_000)
    candidate.onopen = () => {
      finish()
      try { candidate.close(1000, 'Permission check complete') } catch {}
    }
    candidate.onerror = () => finish(new Error('Connection blocked.'))
    candidate.onclose = () => finish(new Error('Shun bridge unavailable.'))
  })
}

async function requestConnection() {
  if (connecting) return
  connecting = true
  render('connecting', 'Connecting…', 'Approve Chrome’s local network request if prompted.')
  try {
    let connectedPort
    for (const port of PORTS) {
      try { connectedPort = await probePort(port); break } catch {}
    }
    if (!connectedPort) throw new Error('No Shun bridge is reachable.')
    await sendMessage({ type: 'connect' })
    const deadline = Date.now() + 6_000
    while (Date.now() < deadline) {
      if (await refreshStatus()) return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('The background connection did not start.')
  } catch {
    render('error', 'Couldn’t connect', 'Keep Shun open and allow local network access when Chrome asks.')
  } finally {
    connecting = false
    connectButton.disabled = false
  }
}

connectButton.addEventListener('click', requestConnection)
void refreshStatus()
setInterval(() => { if (!connecting) void refreshStatus() }, 1_000)
