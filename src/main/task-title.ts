const MAX_TITLE_LENGTH = 48

export function normalizeTaskTitle(value: string) {
  const firstLine = value
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || ''
  const title = firstLine
    .replace(/^(?:title|标题|任务标题)\s*[:：]\s*/i, '')
    .replace(/^["'“‘`]+|["'”’`]+$/g, '')
    .replace(/[。.!！?？;；:：]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return [...title].slice(0, MAX_TITLE_LENGTH).join('')
}


/** A task label must not delay the model run that answers its first message. */
export function taskTitleFromMessage(message: string) {
  return normalizeTaskTitle(message.replace(/^\s*#{1,6}\s+/, ''))
}
