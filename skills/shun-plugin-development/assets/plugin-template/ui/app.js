(() => {
  const channel = new URLSearchParams(location.search).get('channel') || ''
  addEventListener('message', event => {
    const message = event.data
    if (!message || message.source !== 'shun-host' || message.channel !== channel) return
    if (message.type === 'context') document.getElementById('app').textContent = message.context.workspace || 'No workspace selected'
  })
  parent.postMessage({ source: 'shun-plugin', channel, type: 'ready' }, '*')
})()
