const app = document.getElementById('app')

function applyThemeTokens(tokens = {}) {
  const style = document.documentElement.style
  for (const name of ['accent', 'app-bg', 'surface-1', 'surface-2', 'surface-3', 'border-1', 'border-2', 'text-1', 'text-2', 'text-3', 'text-4', 'hover-bg', 'code-bg']) {
    if (typeof tokens[name] === 'string' && tokens[name]) style.setProperty(`--shun-${name}`, tokens[name])
  }
}

window.ShunPlugin.onContext(context => {
  applyThemeTokens(context.themeTokens)
})
