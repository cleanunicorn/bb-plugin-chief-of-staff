// Pure planning for batch_merge: decide order and which PRs are mergeable.
export interface MergeCandidate {
  number: number;
  title: string;
  headRef: string;
  baseRef: string;
  createdAt: string;
  labels: string[];
  draft: boolean;
  approved: boolean;
  changesRequested: boolean;
  ci: "passing" | "failing" | "pending" | "no_checks";
  mergeable: boolean | null; // null = GitHub still computing
  mergeableState?: string;
  body: string | null;
  author: string | null;
}

export interface MergePlanOptions {
  branchPrefix: string;
  onlyOwnBranches: boolean;
  labels: string[];
  requireApproval: boolean;
  defaultBranch: string;
  /** Branches this plugin created (recorded work items), treated as own even without the prefix. */
  ownBranches?: ReadonlySet<string>;
}

export type PlanDecision =
  | { number: number; action: "merge"; reason: string }
  | { number: number; action: "skip"; reason: string }
  | { number: number; action: "conflict"; reason: string };

export interface MergePlan {
  ordered: MergeCandidate[];
  decisions: PlanDecision[];
}

/** Numbers referenced as "depends on #N" / "after #N" / "blocked by #N" in a body. */
export function dependenciesOf(body: string | null): number[] {
  if (!body) return [];
  const deps = new Set<number>();
  const re = /\b(?:depends\s+on|after|blocked\s+by|requires)\s+(?:#|PR\s*#?)(\d+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) deps.add(Number(match[1]));
  return [...deps];
}

/**
 * Order candidates by creation time, then move each PR after any PR it
 * declares a dependency on (topological order; cycles fall back to creation
 * order).
 */
export function orderCandidates(candidates: MergeCandidate[]): MergeCandidate[] {
  const byNumber = new Map(candidates.map((c) => [c.number, c]));
  const sorted = [...candidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
  const result: MergeCandidate[] = [];
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (c: MergeCandidate) => {
    if (visited.has(c.number)) return;
    if (visiting.has(c.number)) return; // cycle; keep creation order
    visiting.add(c.number);
    for (const dep of dependenciesOf(c.body)) {
      const target = byNumber.get(dep);
      if (target) visit(target);
    }
    visiting.delete(c.number);
    visited.add(c.number);
    result.push(c);
  };
  for (const c of sorted) visit(c);
  return result;
}

export function planBatchMerge(candidates: MergeCandidate[], options: MergePlanOptions): MergePlan {
  const ordered = orderCandidates(candidates);
  const decisions: PlanDecision[] = [];
  const willMerge = new Set<number>();
  const candidateNumbers = new Set(candidates.map((c) => c.number));
  for (const pr of ordered) {
    if (pr.baseRef !== options.defaultBranch) {
      decisions.push({ number: pr.number, action: "skip", reason: `base is ${pr.baseRef}, not ${options.defaultBranch}` });
      continue;
    }
    if (options.onlyOwnBranches && !pr.headRef.startsWith(options.branchPrefix) && !options.ownBranches?.has(pr.headRef)) {
      decisions.push({ number: pr.number, action: "skip", reason: `branch ${pr.headRef} is not under ${options.branchPrefix}` });
      continue;
    }
    if (options.labels.length && !options.labels.every((l) => pr.labels.includes(l))) {
      decisions.push({ number: pr.number, action: "skip", reason: `missing label(s) ${options.labels.join(", ")}` });
      continue;
    }
    if (pr.draft) {
      decisions.push({ number: pr.number, action: "skip", reason: "draft" });
      continue;
    }
    if (pr.changesRequested) {
      decisions.push({ number: pr.number, action: "skip", reason: "changes requested" });
      continue;
    }
    if (options.requireApproval && !pr.approved) {
      decisions.push({ number: pr.number, action: "skip", reason: "not approved" });
      continue;
    }
    if (pr.ci === "failing") {
      decisions.push({ number: pr.number, action: "skip", reason: "CI failing" });
      continue;
    }
    if (pr.ci === "pending") {
      decisions.push({ number: pr.number, action: "skip", reason: "CI pending" });
      continue;
    }
    const unmetDeps = dependenciesOf(pr.body).filter((dep) => candidateNumbers.has(dep) && !willMerge.has(dep));
    if (unmetDeps.length) {
      decisions.push({ number: pr.number, action: "skip", reason: `depends on unmerged #${unmetDeps.join(", #")}` });
      continue;
    }
    if (pr.mergeable === false || pr.mergeableState === "dirty") {
      decisions.push({ number: pr.number, action: "conflict", reason: "merge conflict with base" });
      continue;
    }
    if (pr.mergeable === null) {
      decisions.push({ number: pr.number, action: "skip", reason: "mergeability unknown (GitHub still computing)" });
      continue;
    }
    willMerge.add(pr.number);
    decisions.push({ number: pr.number, action: "merge", reason: "green and approved" });
  }
  return { ordered, decisions };
}
