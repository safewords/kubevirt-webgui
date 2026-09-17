/// <reference types="vite/client" />

declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: { shared?: boolean; credentials?: object; wsProtocols?: string[] })
    scaleViewport: boolean
    resizeSession: boolean
    clipViewport: boolean
    viewOnly: boolean
    focusOnClick: boolean
    qualityLevel: number
    compressionLevel: number
    showDotCursor: boolean
    background: string
    readonly capabilities: { power: boolean }
    disconnect(): void
    sendCtrlAltDel(): void
    sendKey(keysym: number, code: string | null, down?: boolean): void
    focus(): void
    blur(): void
    clipboardPasteFrom(text: string): void
    machineShutdown(): void
    machineReboot(): void
    machineReset(): void
  }
}
