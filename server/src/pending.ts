export class PendingWork {
  private readonly jobs = new Set<Promise<unknown>>();

  track<T>(job: Promise<T>): Promise<T> {
    this.jobs.add(job);
    const done = () => this.jobs.delete(job);
    void job.then(done, done);
    return job;
  }

  async drain() {
    while (this.jobs.size) await Promise.allSettled(this.jobs);
  }
}
