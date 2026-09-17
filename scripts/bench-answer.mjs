/**
 * The extractor that turns a model's closing message into the answer that gets
 * scored. It lives in its own module because it is the one place where a harness
 * bug silently becomes a wrong answer: a reply that only wrote tool markup must
 * read as "no answer", never as the answer itself.
 */

/** Tool-markup vocabulary that carries no answer when it is all a line contains. */
const MARKUP_WORDS = /^(?:dsml|tool_calls?|function_calls?|invoke|parameter|antml)[\s\S]*$/i

/**
 * A final message can carry malformed tool markup around the answer, so the answer
 * is extracted with any XML-ish residue and quoting removed. A model sometimes
 * writes a tool call as text instead of calling the tool, and that remnant is not
 * an answer: scoring it would measure the harness rather than the run.
 */
/** Markup a provider uses to delimit a tool call, whether or not the model closed it properly. */
const TOOL_MARKUP = /(?:\uFF5C|\|){0,2}\s*(?:DSML|antml|tool_call|function_call|invoke|parameter)\b|<tool_calls>|<\/?invoke|<parameter/i

/**
 * A reply that is a tool call written as text is not an answer, however the markup was mangled in
 * transit: the text left after stripping tags is often a bare number, and scoring that as the
 * answer reports a provider artifact as a wrong prediction.
 */
export function isToolMarkupReply(text) {
  return TOOL_MARKUP.test(String(text || ''))
}

export function cleanAnswer(text) {
  const raw = String(text || '')
  // A marked answer wins however it was wrapped: a provider can leave its tool markup around a
  // reply that still states the answer, and losing that answer would be the harness's mistake.
  const marked = raw.match(/ANSWER:\s*([^\n]+)/i)?.[1]
  const strip = value => value.replace(/^["'\s]+|["'.\s]+$/g, '').trim()
  if (marked && /[\p{L}\p{N}]/u.test(marked)) {
    const cleaned = strip(marked.replace(/<[^>]*>/g, ' ').replace(/\uFF5C[^\uFF5C\s]*\uFF5C/g, ' '))
    if (cleaned) return cleaned
  }
  // Nothing marked: a reply that is a tool call written as text has no answer in it, whatever
  // the fragments left behind look like.
  if (isToolMarkupReply(raw)) return ''
  const cleaned = raw
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, ' ')
    .replace(/<invoke[\s\S]*?<\/invoke>/gi, ' ')
    .replace(/<parameter[\s\S]*?<\/parameter>/gi, ' ')
    .replace(/\uFF5C[^\uFF5C\s]*\uFF5C/g, ' ')
    .replace(/<\/?[^>]*>/g, ' ')
  const lines = cleaned.split('\n').map(line => strip(line)).filter(line => /[\p{L}\p{N}]{2,}/u.test(line) && !/^[\s<>/]+$/.test(line) && !MARKUP_WORDS.test(line.replace(/^[\s<>/|\uFF5C]+/, '')))
  return lines[lines.length - 1] || ''
}

/**
 * Whether a line can stand as an answer at all. A closing reply that came back as a fragment —
 * a hesitation, a stray punctuation mark — is the model failing to answer, and scoring it as
 * one reports a harness accident as a wrong answer.
 */
const FILLER = /^(?:hmm+|um+|uh+|oh|ok|okay|maybe|well|so|and|but|the|a|an|none|nothing)$/i

export function looksLikeAnswer(text) {
  const value = String(text || '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim()
  if (!value) return false
  if (FILLER.test(value)) return false
  const words = value.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word))
  return words.length >= 2 || value.length >= 4
}
