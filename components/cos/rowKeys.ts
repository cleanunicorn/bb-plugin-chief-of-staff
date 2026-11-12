// React keys for editable list rows. Array indexes shift when a row is
// removed (so the next row inherits the removed row's state) and the rows'
// own fields are edited as the user types, so neither works as a key.
import { useState } from "react";

export interface RowKeys<T extends object> {
  /** The row's key; a row seen for the first time gets a new one. */
  key(row: T): string;
  /** Give `next` (an edited copy of `prev`) the key of `prev`. Returns `next`. */
  carry(prev: T, next: T): T;
}

export function createRowKeys<T extends object>(): RowKeys<T> {
  const ids = new WeakMap<T, string>();
  let n = 0;
  const key = (row: T) => {
    let id = ids.get(row);
    if (!id) ids.set(row, (id = `row-${++n}`));
    return id;
  };
  return {
    key,
    carry(prev, next) {
      if (prev !== next) ids.set(next, key(prev));
      return next;
    },
  };
}

/** Row keys that live as long as the component. */
export function useRowKeys<T extends object>(): RowKeys<T> {
  const [keys] = useState(() => createRowKeys<T>());
  return keys;
}
