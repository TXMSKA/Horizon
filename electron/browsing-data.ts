export const CLEAR_ON_CLOSE_TIMEOUT = 5000;
export async function clearBeforeDeadline(jobs: readonly (() => void | Promise<void>)[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(jobs.map(job => Promise.resolve().then(job))),
      new Promise<void>(resolve => { timer = setTimeout(resolve, CLEAR_ON_CLOSE_TIMEOUT); }),
    ]);
  } finally { clearTimeout(timer); }
}
