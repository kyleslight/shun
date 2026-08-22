import type { Settings } from '../../shared'

export type Accent = NonNullable<Settings['accent']>

export const accentPalette: Record<Accent, string> = {
  blue: '#7899dc',
  sky: '#78acd7',
  teal: '#6faeb2',
  mint: '#7caf91',
  amber: '#c9a861',
  orange: '#d8916b',
  rose: '#d48691',
  pink: '#cf8fb1',
  violet: '#9a86d3',
}

export const accentOptions = Object.keys(accentPalette) as Accent[]

export function accentColor(accent?: string): string {
  return accent && accent in accentPalette ? accentPalette[accent as Accent] : accentPalette.blue
}
