/** Avoid retaining HTTP/1.1 proxy sockets after terminal streaming events. */
export function providerRequestInit(input: string | URL | Request, init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.set('Connection', 'close')
  return { ...init, headers, signal: init?.signal ?? (input instanceof Request ? input.signal : undefined) }
}

/** Recognize an SSE transport terminator without parsing model messages. */
class EventStreamCompletion {
  private line = ''
  private longLine = false
  private data = ''
  private hasData = false
  private longData = false
  private skipLF = false

  push(bytes: Uint8Array): number {
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index]
      if (this.skipLF && byte === 10) { this.skipLF = false; continue }
      this.skipLF = false
      if (byte === 10 || byte === 13) {
        this.skipLF = byte === 13
        if (!this.longLine && !this.line) {
          const complete = this.hasData && !this.longData && this.data === '[DONE]'
          this.data = ''; this.hasData = false; this.longData = false
          if (complete) return index + 1
        } else if (this.line.startsWith('data:')) {
          const value = this.line.slice(5).replace(/^ /, '')
          this.data += `${this.hasData ? '\n' : ''}${value}`
          this.hasData = true
          this.longData ||= this.longLine || this.data.length > 32
          if (this.longData) this.data = ''
        }
        this.line = ''; this.longLine = false
      } else if (this.line.length < 32) this.line += String.fromCharCode(byte)
      else this.longLine = true
    }
    return 0
  }
}

/**
 * Some native HTTP streams deliver the terminal SSE event but never deliver EOF.
 * Finish the transport at that event, retaining every preceding byte, including
 * usage frames. Cancellation of the native reader must not hold completion open.
 */
export function completeProviderResponse(response: Response, cancelTransport?: (reason?: unknown) => void): Response {
  if (!response.body || !/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') || '')) return response
  const reader = response.body.getReader(), completion = new EventStreamCompletion()
  let closed = false
  const cancel = (reason?: unknown) => {
    cancelTransport?.(reason)
    void reader.cancel(reason).catch(() => {})
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (closed) return
        if (next.done) { closed = true; controller.close(); return }
        const end = completion.push(next.value)
        controller.enqueue(end ? next.value.subarray(0, end) : next.value)
        if (end) { closed = true; controller.close(); cancel() }
      } catch (error) {
        if (!closed) { closed = true; controller.error(error) }
      }
    },
    cancel(reason) { closed = true; cancel(reason) },
  })
  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  for (const field of ['url', 'redirected', 'type'] as const)
    Object.defineProperty(wrapped, field, { value: response[field] })
  return wrapped
}
