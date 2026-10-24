/** Keep a task closed to new work until its stop and data mutation both finish. */
export class TaskActions {
  private pending = new Set<string>();

  has(taskId: string) { return this.pending.has(taskId); }

  async run(taskId: string, stop: () => Promise<unknown>, apply: () => unknown | Promise<unknown>) {
    if (this.pending.has(taskId)) return false;
    this.pending.add(taskId);
    try {
      await stop();
      await apply();
      return true;
    } finally {
      this.pending.delete(taskId);
    }
  }
}
