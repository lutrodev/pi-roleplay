import type { Code, Extension, State, Tokenizer } from 'micromark-util-types'

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
// micromark uses negative codes for tabs/virtual spaces (-2/-1) and line endings (<= -3).
const lineEnd = (code: Code) => code === null || code <= -3
const whitespace = (code: Code) => code === null || code < 0 || /\s/u.test(String.fromCodePoint(code))

/** Recognize CJK single-star emphasis before CommonMark can pair adjacent spans incorrectly.
 * Only same-line prose is extended; escapes, entities, code, links and HTML keep their grammar.
 * The normal inline parser still owns the contents, including nested bold and search/dialogue spans.
 */
export function cjkEmphasisPlugin(this: { data(): unknown }) {
  const data = this.data() as { micromarkExtensions?: Extension[] }
  const extensions = (data.micromarkExtensions ??= [])
  extensions.push({ text: { 42: { name: 'cjkEmphasis', tokenize } } })
}

const tokenize: Tokenizer = function (effects, ok, nok) {
  const context = this
  let closingOffset = 0
  function start(code: Code): State | undefined {
    // Never consume a suffix of a longer delimiter run, or reinterpret link/image labels.
    if (context.previous === 42 && context.events.at(-1)?.[1].type !== 'characterEscape') return nok(code)
    if (context.events.some(([event, token]) => event === 'enter' && ['labelLink', 'labelImage'].includes(token.type) && !token._balanced)) return nok(code)
    return effects.check({ tokenize: scan }, open, nok)(code)
  }

  const scan: Tokenizer = function (probe, found, failed) {
    let hasCjk = false, bold = false, starCount = 0, starOffset = 0
    return first
    function first(code: Code): State | undefined {
      probe.enter('data'); probe.consume(code)
      return afterOpen
    }
    function afterOpen(code: Code): State | undefined {
      return code === 42 || whitespace(code) ? failed(code) : inside(code)
    }
    function inside(code: Code): State | undefined {
      if (lineEnd(code) || code === 96 || code === 91 || code === 93 || code === 60 || code === 62) return failed(code)
      if (code === 42) { starCount = 1; starOffset = context.now().offset; probe.consume(code); return stars }
      if (code === 92) { probe.consume(code); return escaped }
      if (code !== null && code >= 0) hasCjk ||= cjk.test(String.fromCodePoint(code))
      probe.consume(code)
      return inside
    }
    function escaped(code: Code): State | undefined {
      if (lineEnd(code)) return failed(code)
      probe.consume(code)
      return inside
    }
    function stars(code: Code): State | undefined {
      if (code === 42) { starCount++; probe.consume(code); return stars }
      if (starCount === 2) { bold = !bold; return inside(code) }
      if (starCount !== 1 || bold || !hasCjk) return failed(code)
      closingOffset = starOffset
      probe.exit('data')
      return found(code)
    }
  }

  return start

  function open(code: Code): State | undefined {
    effects.enter('emphasis'); effects.enter('emphasisSequence')
    effects.consume(code); effects.exit('emphasisSequence')
    effects.enter('emphasisText'); effects.enter('chunkText', { contentType: 'text', _contentTypeTextTrailing: true })
    return content
  }
  function content(code: Code): State | undefined {
    if (code === 42 && context.now().offset === closingOffset) {
      effects.exit('chunkText'); effects.exit('emphasisText')
      effects.enter('emphasisSequence'); effects.consume(code); effects.exit('emphasisSequence'); effects.exit('emphasis')
      return ok
    }
    effects.consume(code)
    return content
  }
}
