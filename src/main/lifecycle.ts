type Shutdown = () => Promise<void> | void;
const shutdowns: Shutdown[] = [];

export function onShutdown(fn: Shutdown) {
  shutdowns.push(fn);
}

export async function shutdownAll() {
  for (const fn of shutdowns) {
    try {
      await fn();
    } catch (err) {
      console.error('shutdown error', err);
    }
  }
}
