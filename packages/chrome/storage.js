/** Serialize short read/modify/write operations inside the MV3 service worker. */
let writing = Promise.resolve();

export function updateStorage(run) {
  const next = writing.then(run, run);
  writing = next.catch(() => {});
  return next;
}
