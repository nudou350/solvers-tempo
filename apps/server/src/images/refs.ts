import type { ImageRef } from "@solvers/shared";
import { imageStore } from "./store.js";

type Row = { id: string; key: string; width: number; height: number };

/** Database rows -> API contract. Without a configured CDN there is no way to build URLs: empty list. */
export function toImageRefs(rows: Row[]): ImageRef[] {
  const store = imageStore();
  if (!store) return [];
  return rows.map((r) => ({ id: r.id, url: store.url(r.key, "full"), thumbUrl: store.url(r.key, "thumb"), width: r.width, height: r.height }));
}
