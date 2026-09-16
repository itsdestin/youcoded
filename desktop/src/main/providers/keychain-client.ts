import type { EventEmitter } from 'node:events';

export type KeychainRequest = { operation: 'available' } | { operation: 'encrypt' | 'decrypt'; value: string };
export type KeychainFailure = 'unavailable' | 'encrypt' | 'decrypt';
export type KeychainResponse = { ok: true; value: string | boolean } | { ok: false; code: KeychainFailure };

// Only this module's fixed, credential-free messages cross the store boundary.
export class KeychainTransportError extends Error {}

export class KeychainHelperError extends KeychainTransportError {
  constructor(public readonly code: KeychainFailure) {
    super(`The keychain helper could not ${code === 'unavailable' ? 'access secure storage' : code} the saved credential. Try again.`);
  }
}

type Child = Pick<EventEmitter, 'on' | 'removeListener'> & {
  send(message: KeychainRequest, callback?: (error: Error | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
};
type Pending = {
  request: KeychainRequest;
  resolve(value: string | boolean): void;
  reject(error: Error): void;
};

/** One private channel, one request at a time. A failed helper is never reused:
 * WHY: Chromium caches failed Linux key initialization for the process lifetime.
 * Keep a successful helper warm instead of launching Electron on every model step. */
export class KeychainClient {
  private child: Child | null = null;
  private queue: Pending[] = [];
  private active: Pending | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly start: () => Child, private readonly timeoutMs = 60_000) {}

  request(request: KeychainRequest): Promise<string | boolean> {
    if (this.closed) return Promise.reject(new KeychainTransportError('The keychain helper is closed.'));
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.active || this.closed || !this.queue.length) return;
    this.active = this.queue.shift()!;
    try {
      if (!this.child) {
        this.child = this.start();
        this.child.on('message', this.onMessage);
        this.child.on('error', this.onError);
        this.child.on('exit', this.onExit);
        this.child.on('disconnect', this.onDisconnect);
      }
      const child = this.child;
      const active = this.active;
      this.timer = setTimeout(() => this.fail(new KeychainTransportError('The keychain helper timed out. Unlock your system keychain and try again.')), this.timeoutMs);
      // WHY: ignore callbacks from a retired child; they cannot fail a later request.
      child.send(active.request, (error) => {
        if (error && this.child === child && this.active === active) this.onError();
      });
    } catch {
      this.fail(new KeychainTransportError('The keychain helper could not start or receive the request. Try again.'));
    }
  }

  private onMessage = (message: unknown): void => {
    if (!this.active) return;
    if (!message || typeof message !== 'object') return this.fail(new KeychainTransportError('The keychain helper returned an invalid response.'));
    const response = message as Partial<KeychainResponse>;
    if (response.ok === false && 'code' in response && ['unavailable', 'encrypt', 'decrypt'].includes(response.code!)) {
      return this.fail(new KeychainHelperError(response.code!));
    }
    if (response.ok !== true || !('value' in response) || typeof response.value !== (this.active.request.operation === 'available' ? 'boolean' : 'string')) {
      return this.fail(new KeychainTransportError('The keychain helper returned an invalid response.'));
    }
    const active = this.active;
    this.clearActive();
    if (response.value === false) {
      this.retire();
      for (const pending of this.queue.splice(0)) {
        if (pending.request.operation === 'available') pending.resolve(false);
        else pending.reject(new KeychainHelperError('unavailable'));
      }
    }
    active.resolve(response.value!);
    this.pump();
  };

  // Never echo native error payloads: the transport carries credentials.
  private onError = (): void => this.fail(new KeychainTransportError('The keychain helper connection failed. Try again.'));
  private onExit = (): void => this.fail(new KeychainTransportError('The keychain helper exited before completing the request. Try again.'));
  private onDisconnect = (): void => this.fail(new KeychainTransportError('The keychain helper disconnected. Try again.'));

  private clearActive(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.active = null;
  }

  private fail(error: Error): void {
    const active = this.active;
    this.clearActive();
    this.retire();
    active?.reject(error);
    // One failed keychain attempt should not open another wallet prompt for each
    // concurrent waiter. A subsequent user/poll retry can start a fresh process.
    for (const pending of this.queue.splice(0)) pending.reject(error);
  }

  private retire(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.removeListener('message', this.onMessage);
    child.removeListener('error', this.onError);
    child.removeListener('exit', this.onExit);
    child.removeListener('disconnect', this.onDisconnect);
    // A final asynchronous send error can arrive after teardown.
    child.on('error', () => undefined);
    // WHY: this disposable Linux helper owns no credential files. A synchronous
    // wallet call may prevent graceful termination; force-stop our exact child
    // so repeated retries cannot accumulate stuck Electron processes.
    child.kill('SIGKILL');
  }

  dispose(): void {
    this.closed = true;
    this.fail(new KeychainTransportError('The keychain helper is closed.'));
  }
}
