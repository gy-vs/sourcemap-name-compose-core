/**
 * Name table with exact-string dedup: names are compared by string identity,
 * so "" , "name" and "name " are three distinct entries.
 */
export class NameTable {
  #names: string[] = [];
  #index = new Map<string, number>();

  intern(name: string): number {
    const hit = this.#index.get(name);
    if (hit !== undefined) return hit;
    const index = this.#names.length;
    this.#names.push(name);
    this.#index.set(name, index);
    return index;
  }

  get size(): number {
    return this.#names.length;
  }

  get names(): readonly string[] {
    return this.#names;
  }

  at(index: number): string | undefined {
    return this.#names[index];
  }

  /**
   * Returns a sorted copy of the table plus remap[oldIndex] = newIndex, so
   * callers that reorder the table can keep every segment's name index
   * pointing at the same string.
   */
  sorted(compare: (a: string, b: string) => number = (a, b) => (a < b ? -1 : a > b ? 1 : 0)): {
    names: string[];
    remap: number[];
  } {
    const order = this.#names.map((_, index) => index).sort((i, j) => compare(this.#names[i], this.#names[j]));
    const names: string[] = new Array(order.length);
    const remap: number[] = new Array(order.length);
    order.forEach((oldIndex, newIndex) => {
      names[newIndex] = this.#names[oldIndex];
      remap[oldIndex] = newIndex;
    });
    return { names, remap };
  }
}
