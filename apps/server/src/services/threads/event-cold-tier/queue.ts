export class SerialJobQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #depth = 0;

  get depth(): number {
    return this.#depth;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    this.#depth += 1;
    const result = this.#tail.then(job, job);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.#depth -= 1;
    });
  }

  idle(): Promise<void> {
    return this.#tail.then(() => undefined);
  }
}
