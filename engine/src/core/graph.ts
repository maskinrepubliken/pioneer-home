/**
 * Dependency graph between derived cells and everything they read. Gives a topological order for
 * glitch-free recomputation and the set of derived cells affected by a change.
 */
import type { Config } from '../config/model.js';

export class DependencyGraph {
  /** cell -> derived cells that read it (directly) */
  private dependents = new Map<string, Set<string>>();
  /** derived cell -> position in topological order */
  private order = new Map<string, number>();
  readonly topo: string[] = [];
  readonly timeDependent: string[] = [];

  constructor(config: Config) {
    const derived = config.derived;
    for (const d of derived.values()) {
      for (const ref of d.refs) {
        let set = this.dependents.get(ref);
        if (!set) this.dependents.set(ref, (set = new Set()));
        set.add(d.id);
      }
      if (d.timeDependent) this.timeDependent.push(d.id);
    }
    // Kahn's algorithm restricted to derived cells. The loader already rejected cycles.
    const indeg = new Map<string, number>();
    for (const d of derived.values()) indeg.set(d.id, d.refs.filter((r) => derived.has(r)).length);
    const queue = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id).sort();
    while (queue.length) {
      const id = queue.shift()!;
      this.order.set(id, this.topo.length);
      this.topo.push(id);
      for (const dep of this.dependents.get(id) ?? []) {
        const n = (indeg.get(dep) ?? 0) - 1;
        indeg.set(dep, n);
        if (n === 0) queue.push(dep);
      }
    }
    if (this.topo.length !== derived.size) {
      const stuck = [...derived.keys()].filter((id) => !this.order.has(id));
      throw new Error(`dependency cycle among derived cells: ${stuck.join(', ')}`);
    }
  }

  /** All derived cells transitively affected by changes to `cells`, in topological order. */
  affected(cells: Iterable<string>): string[] {
    const seen = new Set<string>();
    const stack = [...cells];
    while (stack.length) {
      const c = stack.pop()!;
      for (const dep of this.dependents.get(c) ?? []) {
        if (!seen.has(dep)) {
          seen.add(dep);
          stack.push(dep);
        }
      }
    }
    return [...seen].sort((a, b) => (this.order.get(a) ?? 0) - (this.order.get(b) ?? 0));
  }

  /** Direct readers of a cell (derived cells only). */
  readersOf(cell: string): string[] {
    return [...(this.dependents.get(cell) ?? [])];
  }
}
