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
export function cleanAnswer(text) {
  const cleaned = String(text || '')
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, ' ')
    .replace(/<invoke[\s\S]*?<\/invoke>/gi, ' ')
    .replace(/<parameter[\s\S]*?<\/parameter>/gi, ' ')
    // A provider may delimit its tool markup with full-width bars, and the tag can
    // arrive without its closing bracket, so both shapes have to go.
    .replace(/\uFF5C[^\uFF5C\s]*\uFF5C/g, ' ')
    .replace(/<\/?[^>]*>/g, ' ')
  const strip = value => value.replace(/^["'\s]+|["'.\s]+$/g, '').trim()
  const marked = cleaned.match(/ANSWER:\s*([^\n]+)/i)?.[1]
  if (marked && /[\p{L}\p{N}]/u.test(marked)) return strip(marked)
  const lines = cleaned.split('\n').map(line => strip(line)).filter(line => /[\p{L}\p{N}]{2,}/u.test(line) && !/^[\s<>/]+$/.test(line) && !MARKUP_WORDS.test(line.replace(/^[\s<>/|\uFF5C]+/, '')))
  return lines[lines.length - 1] || ''
}
