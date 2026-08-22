export function contentWindow(content: string, maxChars: number, offset: number, knownHasMore = false) {
  const value = content.slice(offset, offset + maxChars), end = offset + value.length, hasMore = knownHasMore || end < content.length
  return { content_offset: offset, content_end: end, content_characters: content.length, returned_characters: value.length, truncated: offset > 0 || hasMore, has_more: hasMore, content: value }
}
