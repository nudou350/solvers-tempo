// Pure grading rules of the Solver evals (PACKAGE_SPEC.md, evals): a check is a case-insensitive regex, a
// case-insensitive substring, or the absence of a substring.

export type Check = { type: "regex" | "contains" | "not_contains"; value: string; description: string };

export function passes(check: Check, out: string): boolean {
  const text = out.toLowerCase();
  switch (check.type) {
    case "regex":
      return new RegExp(check.value, "iu").test(out);
    case "contains":
      return text.includes(check.value.toLowerCase());
    case "not_contains":
      return !text.includes(check.value.toLowerCase());
    default:
      throw new Error(`unknown check type: ${(check as Check).type}`);
  }
}

/** Descriptions of the checks the answer fails (empty = the case passes). */
export function gradeOutput(checks: readonly Check[], out: string): string[] {
  return checks.filter((k) => !passes(k, out)).map((k) => k.description);
}
