// priority-queue.ts — Cola de prioridades con backpressure y workers concurrentes.
//
// - Items ordenados por prioridad (CRITICAL primero).
// - Si la cola supera maxQueueSize → backpressure (rechaza con retryAfterMs).
// - Items que esperan > maxWaitTimeMs se rechazan automáticamente.
// - El procesador es UNO y despacha por toolName (evita el race de setProcessor).

import { ToolPriority, type PriorityQueueConfig, type ResilienceEvent } from "./types.ts";

export interface QueueItem {
  id: string;
  toolName: string;
  priority: number;
  args: unknown;
  clientId: string;
  enqueuedAt: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  idempotencyKey?: string;
}

export type QueueProcessor = (item: QueueItem) => Promise<unknown>;

export class PriorityQueue {
  private queue: QueueItem[] = [];
  private activeWorkers = 0;
  private isProcessing = false;
  private readonly config: PriorityQueueConfig;
  private eventHandler?: (event: ResilienceEvent) => void;
  private processor?: QueueProcessor;

  constructor(config: Partial<PriorityQueueConfig> = {}, eventHandler?: (event: ResilienceEvent) => void) {
    this.config = {
      maxQueueSize: config.maxQueueSize ?? 100,
      concurrency: config.concurrency ?? 5,
      maxWaitTimeMs: config.maxWaitTimeMs ?? 30_000,
      enableBackpressure: config.enableBackpressure ?? true,
    };
    this.eventHandler = eventHandler;
  }

  setProcessor(fn: QueueProcessor): void {
    this.processor = fn;
  }

  /**
   * ═══ CORE: Encolar un tool call ═══
   * Resuelve cuando el tool se ejecuta; rechaza con BackpressureError si la cola
   * está llena o QueueTimeoutError si expira esperando.
   */
  enqueue(item: {
    id: string;
    toolName: string;
    priority: number;
    args: unknown;
    clientId: string;
    idempotencyKey?: string;
  }): Promise<unknown> {
    if (this.config.enableBackpressure && this.queue.length >= this.config.maxQueueSize) {
      this.eventHandler?.({ type: "queue_full", tool: item.toolName, queueSize: this.queue.length });
      return Promise.reject(
        new BackpressureError(
          `Cola llena (${this.queue.length}/${this.config.maxQueueSize}). Intenta de nuevo más tarde.`,
          this.estimateRetryAfterMs(item.priority)
        )
      );
    }

    return new Promise((resolve, reject) => {
      const queueItem: QueueItem = { ...item, enqueuedAt: Date.now(), resolve, reject };
      this.insertByPriority(queueItem);
      this.processNext();
    });
  }

  private insertByPriority(item: QueueItem): void {
    const index = this.queue.findIndex((q) => q.priority > item.priority);
    if (index === -1) this.queue.push(item);
    else this.queue.splice(index, 0, item);
  }

  private processNext(): void {
    if (this.isProcessing) return;
    if (this.queue.length === 0) return;
    if (this.activeWorkers >= this.config.concurrency) return;

    this.isProcessing = true;
    this.activeWorkers++;
    const item = this.queue.shift()!;

    void (async () => {
      try {
        if (Date.now() - item.enqueuedAt > this.config.maxWaitTimeMs) {
          item.reject(new QueueTimeoutError(`Tool '${item.toolName}' expiró en cola después de ${Date.now() - item.enqueuedAt}ms`));
          return;
        }
        if (!this.processor) throw new Error("No processor set for PriorityQueue");
        const result = await this.processor(item);
        item.resolve(result);
      } catch (error) {
        item.reject(error as Error);
      } finally {
        this.activeWorkers--;
        this.isProcessing = false;
        if (this.queue.length > 0) setImmediate(() => this.processNext());
      }
    })();
  }

  private estimateRetryAfterMs(priority: number): number {
    const higherPriorityItems = this.queue.filter((q) => q.priority <= priority).length;
    return 1000 + higherPriorityItems * 500;
  }

  getStatus(): {
    queueDepth: number;
    activeWorkers: number;
    maxQueueSize: number;
    concurrency: number;
    itemsByPriority: Record<number, number>;
  } {
    const itemsByPriority: Record<number, number> = {};
    for (const item of this.queue) {
      itemsByPriority[item.priority] = (itemsByPriority[item.priority] || 0) + 1;
    }
    return {
      queueDepth: this.queue.length,
      activeWorkers: this.activeWorkers,
      maxQueueSize: this.config.maxQueueSize,
      concurrency: this.config.concurrency,
      itemsByPriority,
    };
  }

  drain(): void {
    for (const item of this.queue) item.reject(new Error("Queue drained"));
    this.queue = [];
  }
}

export class BackpressureError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "BackpressureError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class QueueTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueTimeoutError";
  }
}