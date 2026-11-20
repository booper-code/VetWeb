/** Bound waits even if an adapter ignores its AbortSignal. */
export function withinDeadline(work, signal) {
  return new Promise((resolve, reject) => {
    const finish = (deliver, value) => {
      signal?.removeEventListener('abort', cancel);
      deliver(value);
    };
    const cancel = () => finish(reject, new Error('Request deadline reached'));
    Promise.resolve(work).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
  });
}
