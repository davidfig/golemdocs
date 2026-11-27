// What the page's main thread was doing while an edit's answer from the layout worker waited to be taken up (View › Debug › Edit
// times, "page busy"). Places where work starts on the page call `pageTask(name)`: the worker's answers, the frame, input, the
// autosave, the vault sync, the room. Work started anywhere else (a storage callback, a reply from the desktop shell, a timer
// nobody named) is counted as "other": after each named task a message is queued to the page itself, and when it is handled the
// named task is over, so whatever runs next without a name is not put down to it. Only while Edit times is on.

import { clock, TaskLog, type TaskTime } from './layout/taskLog.ts';

let log: TaskLog | null = null;
let channel: MessageChannel | null = null;
let otherQueued = false;

const INPUT_EVENTS = ['keydown', 'keyup', 'beforeinput', 'input', 'pointerdown', 'pointermove', 'pointerup', 'wheel', 'compositionupdate'] as const;
const onInput = (event: Event) => pageTask(event.type);

/** Starts or stops following the page's tasks. */
export function followPageTasks(on: boolean): void {
  if (on === (log !== null)) return;
  for (const type of INPUT_EVENTS) (on ? addEventListener : removeEventListener)(type, onInput, { capture: true });
  if (on) {
    log = new TaskLog();
    channel = new MessageChannel();
    channel.port1.onmessage = () => {
      otherQueued = false;
      log?.begin('other');
    };
  } else {
    channel?.port1.close();
    log = channel = null;
    otherQueued = false;
  }
}

/** A task named `name` starts on the page now. */
export function pageTask(name: string): void {
  if (!log) return;
  log.begin(name);
  if (!otherQueued) {
    otherQueued = true;
    channel!.port2.postMessage(0);
  }
}

/** What the page did between `from` and `to` (`clock()` times), most first. */
export function pageTasksWithin(from: number, to: number): TaskTime[] {
  return log?.within(from, to) ?? [];
}

export { clock };
