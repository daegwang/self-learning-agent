const enabled = !process.env.NO_COLOR

const code = (open: number, close: number) =>
  enabled
    ? (s: string) => `\x1b[${open}m${s}\x1b[${close}m`
    : (s: string) => s

export const bold = code(1, 22)
export const dim = code(2, 22)
export const red = code(31, 39)
export const green = code(32, 39)
export const yellow = code(33, 39)
export const cyan = code(36, 39)
export const magenta = code(35, 39)
export const gray = code(90, 39)

export const orange = enabled
  ? (s: string) => `\x1b[38;5;208m${s}\x1b[39m`
  : (s: string) => s

export const salmon = enabled
  ? (s: string) => `\x1b[38;5;174m${s}\x1b[39m`
  : (s: string) => s

export const seafoam = enabled
  ? (s: string) => `\x1b[38;5;151m${s}\x1b[39m`
  : (s: string) => s

export const steelblue = enabled
  ? (s: string) => `\x1b[38;5;110m${s}\x1b[39m`
  : (s: string) => s

export const skyblue = enabled
  ? (s: string) => `\x1b[38;5;117m${s}\x1b[39m`
  : (s: string) => s

export const teal = enabled
  ? (s: string) => `\x1b[38;5;37m${s}\x1b[39m`
  : (s: string) => s

export function spinner(message: string): { stop: (final: string) => void } {
  if (!enabled || !process.stderr.isTTY) {
    process.stderr.write(message + '\n')
    return { stop: (final: string) => process.stderr.write(final + '\n') }
  }

  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let i = 0

  const write = () => {
    process.stderr.write(`\r\x1b[K${cyan(frames[i % frames.length])} ${message}`)
    i++
  }

  write()
  const id = setInterval(write, 80)

  return {
    stop(final: string) {
      clearInterval(id)
      process.stderr.write(`\r\x1b[K${final}\n`)
    }
  }
}
