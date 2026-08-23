chrome.runtime.sendMessage({ type: 'status' }, response => {
  const connected = Boolean(response?.connected), node = document.getElementById('state')
  node.classList.toggle('connected', connected)
  document.getElementById('label').textContent = connected ? 'Connected to Shun' : 'Waiting for Shun'
  document.getElementById('detail').textContent = connected ? `${response.attachedTabs || 0} controlled tab${response.attachedTabs === 1 ? '' : 's'}` : 'Open the Shun desktop app to connect.'
})
