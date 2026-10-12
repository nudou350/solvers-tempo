import { notFound } from "next/navigation";

// Any path without a page lands here to use the language's not-found.
export default function CatchAll() {
  notFound();
}
