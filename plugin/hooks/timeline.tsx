// The session at a glance: one bar per turn, in the color of whoever asked
// for it, as tall as it took. Hover it or walk it with ←/→ to read each
// prompt; click or Enter posts the turn to the hooks, which scroll the
// transcript to it. `modern`: the engine draws the type scale (2.1.299+).

import type { ClientModule } from 'claude-code'

type Turn = { who: string; color: string; prompt: string; seconds: number | null }
type Props = { turns: Turn[]; claude: string; modern: boolean }
type State = { cursor: number; hover: number | null }

const BARS = '▁▂▃▄▅▆▇█'
const bar = (seconds: number | null) => (seconds === null ? '·' : BARS[Math.min(BARS.length - 1, Math.round(Math.log2(1 + seconds / 3)))]!)
const took = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`)

let latest: Props = { turns: [], claude: '', modern: false }

const Timeline: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  latest = props
  if (surface.state === undefined) {
    surface.setState({ cursor: Math.max(0, props.turns.length - 1), hover: null })
    // Keys move at once, never animated: keyboard users are moving fast.
    surface.onKey(event => {
      const s = surface.state
      if (!s) return
      const last = latest.turns.length - 1
      if (event.key === 'left') surface.setState({ cursor: Math.max(0, s.cursor - 1), hover: null })
      else if (event.key === 'right') surface.setState({ cursor: Math.min(last, s.cursor + 1), hover: null })
      else if (event.key === 'home') surface.setState({ cursor: 0, hover: null })
      else if (event.key === 'end') surface.setState({ cursor: last, hover: null })
      else if (event.key === 'return') surface.post({ turn: s.cursor })
    })
    surface.onPointer(event => {
      const s = surface.state
      if (!s) return
      // Two columns a bar, the bar and its gap; the newest 60 are drawn.
      const first = Math.max(0, latest.turns.length - 60)
      const at = event.y <= 1 && event.x >= 0 ? first + Math.floor(event.x / 2) : -1
      const inside = at >= first && at < latest.turns.length
      if (event.type === 'down' && inside) {
        surface.setState({ cursor: at, hover: null })
        surface.post({ turn: at })
        return
      }
      const hover = event.type === 'leave' || !inside ? null : at
      if (hover !== s.hover) surface.setState({ ...s, hover })
    })
  }
  const s = surface.state ?? { cursor: 0, hover: null }
  const first = Math.max(0, props.turns.length - 60)
  const shown = props.turns.slice(first)
  const at = Math.min(s.hover ?? s.cursor, props.turns.length - 1)
  const turn = props.turns[at]
  const longest = Math.max(0, ...props.turns.map(t => t.seconds ?? 0))
  const strong = props.modern ? { weight: 'semibold' as const } : { bold: true }
  const steady = props.modern ? { tabular: true } : {}
  if (!turn) return <Text dimColor>No turns yet.</Text>
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {shown.map((t, i) => (
          <Text key={`bar-${first + i}`} color={t.color} dimColor={first + i !== at && s.hover !== null}>
            {bar(t.seconds)}{' '}
          </Text>
        ))}
      </Box>
      <Box flexDirection="row">
        {shown.map((t, i) => (
          <Text key={`at-${first + i}`} color={first + i === s.cursor ? t.color : undefined}>
            {first + i === s.cursor ? '▔ ' : '  '}
          </Text>
        ))}
      </Box>
      <Box flexDirection="row" gap={1}>
        <Text color={turn.color} {...strong}>
          {turn.who}
        </Text>
        <Text dimColor {...steady}>
          {`turn ${at + 1} of ${props.turns.length}${turn.seconds === null ? ' · running' : ` · ${took(turn.seconds)}`}${turn.seconds !== null && turn.seconds === longest && props.turns.length > 1 ? ' · the longest' : ''}`}
        </Text>
      </Box>
      <Text wrap="truncate-end">{`“${turn.prompt}”`}</Text>
    </Box>
  )
}

export default Timeline
