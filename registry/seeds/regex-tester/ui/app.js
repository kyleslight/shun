const patternInput = document.getElementById('pattern')
const flagsInput = document.getElementById('flags')
const sampleInput = document.getElementById('sample')
const result = document.getElementById('result')

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

function render(html) {
  result.innerHTML = html
}

function evaluate() {
  const pattern = patternInput.value
  const sample = sampleInput.value
  if (!pattern) return render('<p class="hint">Enter a regular expression.</p>')
  if (!sample) return render('<p class="hint">Paste the text to test against.</p>')

  let regex
  try {
    regex = new RegExp(pattern, flagsInput.value.includes('g') ? flagsInput.value : `${flagsInput.value}g`)
  } catch (error) {
    return render(`<p class="error">${escapeHtml(error.message)}</p>`)
  }

  const matches = [...sample.matchAll(regex)]
  if (!matches.length) return render('<p class="hint">No matches.</p>')

  const rows = matches.map(match => {
    const groups = Object.entries(match.groups || {}).map(([name, value]) => `<span class="group"><b>${escapeHtml(name)}</b>${escapeHtml(value ?? '')}</span>`).join('')
    const numbered = match.slice(1).map((value, index) => `<span class="group"><b>$${index + 1}</b>${escapeHtml(value ?? '')}</span>`).join('')
    return `<li><code>${escapeHtml(match[0]) || '<em>empty</em>'}</code><small>index ${match.index}</small>${groups || numbered ? `<div class="groups">${groups}${numbered}</div>` : ''}</li>`
  }).join('')

  render(`<p class="count">${matches.length} match${matches.length === 1 ? '' : 'es'}</p><ol>${rows}</ol>`)
}

for (const element of [patternInput, flagsInput, sampleInput]) element.addEventListener('input', evaluate)
evaluate()
