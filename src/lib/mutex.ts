/** Runs async sections one at a time, in call order. */
export class Mutex {
    private tail: Promise<void> = Promise.resolve();

    /**
     * Runs `fn` once every previously queued section has finished.
     *
     * @param fn - the critical section
     */
    public async run<T>(fn: () => Promise<T>): Promise<T> {
        const previous = this.tail;
        let release!: () => void;
        this.tail = new Promise<void>(resolve => (release = resolve));
        await previous;
        try {
            return await fn();
        } finally {
            release();
        }
    }
}
