import WebSocket, { type RawData } from 'ws'

type MessageHandler = (data: string) => void
type CloseHandler = () => void

/** Lightweight wrapper around `ws` for one daemon WebSocket connection. */
export class WSClient {
  private ws: WebSocket | undefined
  private messageHandlers: MessageHandler[] = []
  private closeHandlers: CloseHandler[] = []
  private openHandlers: Array<() => void> = []
  private closed = false

  constructor(private readonly url: string) {}

  connect(): void {
    if (this.ws || this.closed) return
    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.on('open', () => {
      for (const h of this.openHandlers) h()
    })

    ws.on('message', (data: RawData) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : data.toString('utf8')
      for (const h of this.messageHandlers) h(text)
    })

    ws.on('close', () => {
      this.ws = undefined
      for (const h of this.closeHandlers) h()
    })

    ws.on('error', () => {
      // Surface only via close event; ws emits close after error too.
    })
  }

  send(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data)
  }

  close(): void {
    this.closed = true
    this.ws?.close()
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler)
  }

  onClose(handler: CloseHandler): void {
    this.closeHandlers.push(handler)
  }

  onOpen(handler: () => void): void {
    this.openHandlers.push(handler)
  }
}
