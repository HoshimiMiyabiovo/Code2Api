import { GatewayError } from '../errors.js';

interface Waiter {
  timer: NodeJS.Timeout;
  grant: (release: () => void) => void;
}

export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly max: number,
    private readonly maxWaitMs: number,
  ) {}

  snapshot(): { active: number; queued: number; max: number } {
    return { active: this.active, queued: this.queue.length, max: this.max };
  }

  async acquire(): Promise<() => void> {
    if (this.max <= 0) return () => {};
    if (this.active < this.max) {
      this.active += 1;
      return this.releaseHandle();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(
            new GatewayError('网关并发已满，请稍后重试', {
              status: 503,
              type: 'overloaded_error',
              code: 'gateway_busy',
              retryAfterSeconds: 5,
            }),
          );
        }, this.maxWaitMs),
        grant: (release) => resolve(release),
      };
      this.queue.push(waiter);
    });
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain(): void {
    while (this.max > 0 && this.active < this.max && this.queue.length > 0) {
      const waiter = this.queue.shift();
      if (!waiter) break;
      clearTimeout(waiter.timer);
      this.active += 1;
      waiter.grant(this.releaseHandle());
    }
  }
}
