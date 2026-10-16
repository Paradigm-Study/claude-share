// While Claude works: whose turn it is and how long it has run, ticking on the
// surface's own frame clock so the plugin never redraws for it.
//   variant 'band': one line for the row above the prompt, cut at its end
//   variant 'room': the Room's "now" block, with what Claude is doing
// `modern`: the engine draws the type scale (2.1.299+); else bold and plain digits.

import type { ClientModule } from 'claude-code'

type Props = {
  variant: 'band' | 'room'
  who: { name: string; color: string }
  /** The turn is for this person. */
  mine: boolean
  doing: string
  /** How long the turn had run when this was drawn. */
  elapsedMs: number
  claude: string
  modern: boolean
}
type State = { tick: number; startedAt: number }

const SPIN = ['◐', '◓', '◑', '◒']

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const Live: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    // The timer runs on this surface's clock from what the hooks said.
    surface.setState({ tick: 0, startedAt: Date.now() - props.elapsedMs })
    // A turn of the spinner each 300 ms, at an even pace; the seconds follow.
    surface.every(300, () => {
      const s = surface.state
      if (s) surface.setState({ ...s, tick: s.tick + 1 })
    })
  }
  const s = surface.state ?? { tick: 0, startedAt: Date.now() - props.elapsedMs }
  const spin = SPIN[s.tick % SPIN.length]
  const elapsed = clock(Date.now() - s.startedAt)
  const strong = props.modern ? { weight: 'semibold' as const } : { bold: true }
  const steady = props.modern ? { tabular: true } : {}
  const name = props.mine ? (
    <Text color={props.who.color} {...strong}>
      you
    </Text>
  ) : (
    <Text color={props.who.color} {...strong}>
      {props.who.name}
    </Text>
  )

  if (props.variant === 'band')
    return (
      <Text wrap="truncate-end">
        <Text color={props.claude}>{spin} </Text>
        <Text dimColor>Claude for </Text>
        {name}
        <Text dimColor {...steady}>
          {` ${elapsed}`}
        </Text>
        {props.doing ? <Text dimColor>{` · ${props.doing}`}</Text> : null}
      </Text>
    )

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Text wrap="truncate-end">
          <Text color={props.claude}>{spin} </Text>
          <Text {...strong}>Claude</Text>
          <Text dimColor> is working for </Text>
          {name}
        </Text>
        <Text {...steady} {...(props.modern ? { weight: 'medium' as const } : {})}>
          {elapsed}
        </Text>
      </Box>
      {props.doing ? (
        <Text dimColor wrap="truncate-end" {...(props.modern ? { size: 'footnote' as const } : {})}>
          {props.doing}
        </Text>
      ) : null}
    </Box>
  )
}

export default Live
