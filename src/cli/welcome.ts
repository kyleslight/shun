import { stripTerminalSequences, truncateToWidth, type Component } from '@earendil-works/pi-tui'

const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x1f\x7f]/g, '')
export const accent = (text: string) => `\x1b[38;5;205m${text}\x1b[0m`
const muted = (text: string) => `\x1b[2m${text}\x1b[0m`
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`
declare const SHUN_CLI_VERSION: string
const version = typeof SHUN_CLI_VERSION === 'undefined' ? 'dev' : SHUN_CLI_VERSION

export class WelcomeHeader implements Component {
  private state = { title: '', model: '', workspace: '', running: false, compact: false, ready: false }
  update(state: Partial<typeof this.state>) { this.state = { ...this.state, ...state } }
  invalidate() {}
  render(width: number): string[] {
    const state = this.state, contentWidth = Math.max(1, width - 2)
    const line = (text: string) => width < 3 ? truncateToWidth(text, Math.max(1, width)) : ` ${truncateToWidth(text, contentWidth)}`
    const workspace = clean(state.workspace) || 'No project selected'
    const model = clean(state.model) || 'Choose a model to get started'
    if (state.compact || width < 34) return [
      '', line(`${accent(bold('SHUN'))}  ${muted(clean(state.title) || `v${version}`)}${state.running ? accent('  • Running') : ''}`),
      '',
    ]
    if (width < 54) return [
      '', line(accent(bold('SHUN'))),
      line(muted('/new to start · /resume for history')),
      line(muted('Also available on Desktop:')),
      line('https://shunagent.com/download'), '',
    ]
    return [
      '',
      line(accent('   _____ __  ____  ___   __')),
      line(accent('  / ___// / / / / / / | / /')),
      line(accent('  \\__ \\/ /_/ / / / /  |/ /')),
      line(accent(' ___/ / __  / /_/ / /|  /')),
      line(`${accent('/____/_/ /_/\\____/_/ |_/')}    ${muted(`v${version}`)}`),
      '',
      line(muted('Serious coding agents, running on hardware you own.')),
      '',
      line(state.ready ? clean(state.title) || 'New conversation' : 'Welcome to Shun'),
      '',
      line(`${muted('MODEL      ')}${model}`),
      line(`${muted('PROJECT    ')}${workspace}`),
      '',
      line(muted('/new to start · /resume for history')),
      line(muted('Also available on Desktop:')),
      line('https://shunagent.com/download'),
      '',
    ]
  }
}
