/**
 * Uploading a file into a DataVolume, over a WebSocket.
 *
 * `upload.begin` creates the DataVolume and hands back a one-time ticket;
 * the file then goes over `/ws/upload/<ticket>` in chunks, each acknowledged
 * before the next is read, so memory stays flat for a multi-gigabyte ISO and
 * the browser never outruns the storage backend.
 *
 * Uploads live here rather than in a dialog, so closing the dialog does not
 * stop one; the Images panel lists them while they run.
 */
import { reactive } from 'vue'
import { gateway, errorMessage } from '@/api/gateway'
import { useTasks } from '@/stores/tasks'
import { toast } from '@/services/dialogs'
import type { ImageType } from './helpers'

export type UploadStatus = 'starting' | 'preparing' | 'uploading' | 'processing' | 'done' | 'error' | 'cancelled'

export interface UploadJob {
  id: number
  fileName: string
  namespace: string
  name: string
  total: number
  sent: number
  status: UploadStatus
  error?: string
  task?: string
  startedAt: number
  /** Bytes per second over the upload so far. */
  rate: number
}

export interface UploadOptions {
  namespace: string
  name: string
  imageType?: ImageType | null
  storageClass?: string | null
  /** The disk to create when the image's virtual size exceeds the file (qcow2, VMDK), e.g. `20Gi`. */
  diskSize?: string | null
}

export const uploads = reactive({ jobs: [] as UploadJob[] })

const sockets = new Map<number, WebSocket>()
let nextId = 1

function active() {
  return uploads.jobs.some((j) => j.status === 'starting' || j.status === 'preparing' || j.status === 'uploading')
}

window.addEventListener('beforeunload', (event) => {
  if (active()) {
    event.preventDefault()
    event.returnValue = ''
  }
})

/** Start uploading `file`. Resolves with the job once it has started; progress is reactive. */
export async function startUpload(file: File, options: UploadOptions): Promise<UploadJob> {
  const job = reactive<UploadJob>({
    id: nextId++,
    fileName: file.name,
    namespace: options.namespace,
    name: options.name,
    total: file.size,
    sent: 0,
    status: 'starting',
    startedAt: Date.now(),
    rate: 0,
  })
  uploads.jobs.unshift(job)

  let begun: { task: string; ticket: string; path: string }
  try {
    begun = await gateway.call('upload.begin', {
      namespace: options.namespace,
      name: options.name,
      size: file.size,
      imageType: options.imageType ?? 'disk',
      storageClass: options.storageClass || undefined,
      diskSize: options.diskSize || undefined,
      fileName: file.name,
    })
  } catch (e) {
    job.status = 'error'
    job.error = errorMessage(e)
    throw e
  }
  job.task = begun.task
  job.status = 'preparing'
  void transfer(job, file, begun.path)
  return job
}

async function transfer(job: UploadJob, file: File, path: string) {
  const socket = new WebSocket(gateway.url(path))
  socket.binaryType = 'arraybuffer'
  sockets.set(job.id, socket)

  let waitAck: ((bytes: number) => void) | null = null
  let failAck: ((error: Error) => void) | null = null

  const fail = (message: string) => {
    if (job.status === 'done' || job.status === 'cancelled' || job.status === 'error') return
    job.status = 'error'
    job.error = message
    failAck?.(new Error(message))
    toast('error', `Upload of ${job.fileName} failed`, message, job.task)
  }

  socket.onmessage = async (event) => {
    let message: any
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data))
    } catch {
      return
    }
    if (message.error) return fail(message.error)
    if (message.ack !== undefined) {
      waitAck?.(message.ack)
      return
    }
    if (message.done) {
      job.sent = job.total
      job.status = 'processing'
      const tasks = useTasks()
      const result = job.task ? await tasks.wait(job.task) : null
      if (result && result.status !== 'ok') {
        fail(result.message ?? 'CDI could not process the image')
      } else {
        job.status = 'done'
        toast('success', `Uploaded ${job.fileName}`, `${job.namespace}/${job.name} is ready`)
      }
      return
    }
    if (message.ready) {
      job.status = 'uploading'
      const chunkSize: number = message.chunkSize ?? 4 * 1024 * 1024
      const started = performance.now()
      try {
        for (let offset = 0; offset < file.size; offset += chunkSize) {
          if (socket.readyState !== WebSocket.OPEN || job.status !== 'uploading') return
          const buffer = await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer()
          const acked = new Promise<number>((resolve, reject) => {
            waitAck = resolve
            failAck = reject
          })
          socket.send(buffer)
          job.sent = await acked
          const seconds = (performance.now() - started) / 1000
          job.rate = seconds > 0 ? job.sent / seconds : 0
        }
      } catch {
        /* reported by `fail` */
      }
    }
  }

  socket.onclose = (event) => {
    sockets.delete(job.id)
    if (job.status === 'uploading' || job.status === 'preparing' || job.status === 'starting') {
      fail(event.reason || 'the upload connection closed')
    }
  }
}

/** Stop an upload. The DataVolume is left behind for the user to remove. */
export function cancelUpload(job: UploadJob) {
  if (job.status !== 'preparing' && job.status !== 'uploading' && job.status !== 'starting') return
  job.status = 'cancelled'
  job.error = 'cancelled'
  sockets.get(job.id)?.close()
  if (job.task) gateway.call('tasks.stop', { id: job.task }).catch(() => {})
}

export function dismissUpload(job: UploadJob) {
  const index = uploads.jobs.indexOf(job)
  if (index !== -1) uploads.jobs.splice(index, 1)
}
