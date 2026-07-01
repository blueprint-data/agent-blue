import { IterationBudgetConfig } from "./types.js";

/**
 * Thread-safe iteration budget for agent execution turns.
 * 
 * - Parent agent gets maxTotal (default 90) iterations.
 * - Subagents get independent budgets (default 50).
 * - Tool cache hits should refund() one iteration.
 * - Warehouse timeouts should NOT consume an iteration.
 * 
 * Pattern from Hermes Agent (206k ⭐):
 * - consume/refund pattern with thread safety
 * - maxTotal ceiling per agent
 * - refund for cache hits (execute_code in Hermes)
 */
export class IterationBudget {
  private readonly _maxTotal: number;
  private _used: number;
  private readonly _label: string;

  constructor(config: IterationBudgetConfig) {
    this._maxTotal = config.maxTotal;
    this._used = 0;
    this._label = config.label ?? "agent";
  }

  /**
   * Try to consume one iteration. Returns true if allowed (budget remains).
   * Returns false if budget is exhausted.
   */
  consume(): boolean {
    if (this._used >= this._maxTotal) {
      return false;
    }
    this._used += 1;
    return true;
  }

  /**
   * Give back one iteration (e.g. tool result was cached, no actual turn needed).
   */
  refund(): void {
    if (this._used > 0) {
      this._used -= 1;
    }
  }

  /** Number of iterations consumed so far */
  get used(): number {
    return this._used;
  }

  /** Number of iterations remaining */
  get remaining(): number {
    return Math.max(0, this._maxTotal - this._used);
  }

  /** Maximum iterations allowed */
  get maxTotal(): number {
    return this._maxTotal;
  }

  /** Label for diagnostics */
  get label(): string {
    return this._label;
  }

  /** Reset budget (e.g. for new session) */
  reset(): void {
    this._used = 0;
  }

  /** Human-readable status */
  get status(): string {
    return `${this._label}: ${this._used}/${this._maxTotal} used, ${this.remaining} remaining`;
  }
}
