import { directoriesOverlap } from '../../../../packages/rp-core/src/workspace.ts'

interface Access { directory: string; write: boolean }
interface Waiting extends Access { start: () => void }
const conflicts = (a: Access, b: Access) => (a.write || b.write) && directoriesOverlap(a.directory, b.directory)
/** Coordinate all app tool requests before dispatch. Independent directories and compatible reads can proceed. */
export class WorkspaceDispatch {
  private readonly active = new Set<Access>()
  private readonly waiting: Waiting[] = []
  acquire(directory: string, write: boolean, signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return }
      const cancel = () => { const index = this.waiting.indexOf(item); if (index >= 0) this.waiting.splice(index, 1); reject(signal.reason); this.wake() }
      const item: Waiting = { directory, write, start: () => {
        signal.removeEventListener('abort', cancel); this.active.add(item)
        let released = false
        resolve(() => { if (!released) { released = true; this.active.delete(item); this.wake() } })
      } }
      this.waiting.push(item); signal.addEventListener('abort', cancel, { once: true }); this.wake()
    })
  }
  private wake() {
    for (let index = 0; index < this.waiting.length && this.active.size < 8;) {
      const item = this.waiting[index]!
      // A queued writer also blocks later overlapping reads, so it cannot starve.
      if ([...this.active, ...this.waiting.slice(0, index)].some(other => conflicts(item, other))) { index++; continue }
      this.waiting.splice(index, 1); item.start()
    }
  }
}
