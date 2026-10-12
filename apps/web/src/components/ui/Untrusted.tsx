import { revealHidden } from "@/lib/submissions-ui";

/**
 * Text written by a creator (name, bio, tagline, category, validator messages, reviewer notes) shown on the submission
 * and review screens: invisible and direction characters become visible `[U+XXXX]`, so nobody can hide instructions or
 * change the reading order. Always text, never HTML.
 */
export function Untrusted({ children }: { children: string | null | undefined }) {
  return <>{revealHidden(children ?? "").text}</>;
}

/** Same rule for attributes and labels (plain string). */
export const untrusted = (text: string | null | undefined): string => revealHidden(text ?? "").text;
