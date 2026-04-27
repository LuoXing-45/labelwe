declare class Worker {
  constructor(scriptURL: string | URL, options?: WorkerOptions);
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

