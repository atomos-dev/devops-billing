# Opportunities Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the unused `opportunities` feature stack and its obsolete documents without affecting the project’s billing, resources, trends, settings, or sync capabilities.

**Architecture:** Treat this as a retirement task, not a refactor. Remove the dashboard page, API route, service module, tests, and documents tied to `cost-governance`, then keep a small regression surface in existing navigation E2E coverage to prove the retired UI and API stay gone. Do not add any zombie-assessment placeholder code in this cleanup.

**Tech Stack:** Next.js App Router, React, TypeScript, Vitest, Playwright, ESLint

---

## Source Requirements

This plan implements the user-approved cleanup scope:

- delete the `opportunities` frontend page
- delete the `opportunities` API
- delete the `src/services/cost-governance/` implementation
- delete related tests
- delete related old documents
- do **not** leave a zombie-assessment placeholder entrypoint
- finish cleanup first; discuss the new zombie design later

---

## File Structure

### Existing files to modify

- `src/components/layout/sidebar.tsx`
  - Remove the `Opportunities` navigation item.
  - Remove the now-unused `ShieldAlert` icon import.

- `e2e/navigation.spec.ts`
  - Add focused retirement regressions in an existing E2E file:
    - sidebar no longer shows `Opportunities`
    - `/opportunities` resolves to a not-found page after login
    - `/api/v1/opportunities` returns `404`

### Existing files to delete

- `src/app/(dashboard)/opportunities/page.tsx`
- `src/app/api/v1/opportunities/route.ts`
- `src/app/api/__tests__/opportunities-route.test.ts`
- `e2e/opportunities.spec.ts`
- `src/services/cost-governance/index.ts`
- `src/services/cost-governance/engine.ts`
- `src/services/cost-governance/types.ts`
- `src/services/cost-governance/signals.ts`
- `src/services/cost-governance/normalizers/aws.ts`
- `src/services/cost-governance/rules/expensive-unowned-resource.ts`
- `src/services/cost-governance/rules/high-cost-service-without-clear-resource-ownership.ts`
- `src/services/cost-governance/rules/long-tail-resource-spread.ts`
- `src/services/cost-governance/rules/overprovisioned-high-baseline-compute.ts`
- `src/services/cost-governance/rules/region-or-service-cost-anomaly.ts`
- `src/services/cost-governance/rules/resource-group-cost-anomaly.ts`
- `src/services/cost-governance/rules/stopped-but-costing.ts`
- `src/services/cost-governance/rules/uncategorized-high-cost-resource.ts`
- `src/services/cost-governance/__tests__/service.test.ts`
- `src/services/cost-governance/__tests__/aws-normalizer.test.ts`
- `docs/2026-03-19-cost-governance-phase1-prd.md`
- `docs/2026-03-19-cost-governance-phase1-technical-design.md`
- `docs/2026-03-19-zombie-assessment-implementation-design.md`

### Files that should stay untouched

- `src/services/billing.ts`
- `src/services/sync.ts`
- `src/app/api/v1/summary/route.ts`
- `src/app/api/v1/bills/route.ts`
- `src/app/api/v1/resources/route.ts`
- `src/app/api/v1/trends/route.ts`
- `src/app/api/v1/manual-costs/route.ts`
- `src/app/api/v1/sync/route.ts`
- `src/app/(dashboard)/bills/page.tsx`
- `src/app/(dashboard)/resources/page.tsx`
- `src/app/(dashboard)/trends/page.tsx`
- `src/app/(dashboard)/settings/page.tsx`

These are part of the retained billing/resource baseline and should not be changed unless verification proves a direct dependency was missed.

---

### Task 1: Lock the UI retirement with failing regression tests

**Deliverable / Acceptance Criteria:** Existing navigation E2E coverage explicitly fails until the `Opportunities` link and page are removed.

**Dependencies:** Playwright login helper and current dashboard shell.

**Risks / Mitigation:** The retired-route assertion should prove the route is gone, not depend on one English 404 string. Prefer the route response status (`404`) plus the absence of the old `Opportunities` heading; only use shared 404 copy as a secondary signal if the app keeps it stable.

**Rollback:** Revert only the `e2e/navigation.spec.ts` edits if the cleanup scope changes before implementation.

**Files:**
- Modify: `e2e/navigation.spec.ts`
- Test: `e2e/navigation.spec.ts`

- [ ] **Step 1: Add a failing test proving the sidebar no longer shows the retired Opportunities link**

```ts
test("sidebar does not show the retired Opportunities link", async ({ page }) => {
  const sidebar = page.locator("aside");
  await expect(sidebar.locator("text=Opportunities")).toHaveCount(0);
});
```

- [ ] **Step 2: Add a failing test proving the retired page path now resolves to not-found**

```ts
test("retired Opportunities page shows not-found after login", async ({ page }) => {
  const response = await page.goto("/opportunities");

  expect(response?.status()).toBe(404);
  await expect(page).toHaveURL("/opportunities");
  await expect(page.getByRole("heading", { name: "Opportunities" })).toHaveCount(0);
});
```

- [ ] **Step 3: Run the navigation spec subset to verify the new regressions fail**

Run: `npx playwright test e2e/navigation.spec.ts --grep "retired Opportunities|sidebar does not show the retired Opportunities link"`
Expected: FAIL because the sidebar link still exists and the page still renders.

---

### Task 2: Remove the Opportunities UI entrypoints

**Deliverable / Acceptance Criteria:** The sidebar no longer exposes `Opportunities`, the dashboard page file is gone, and the old page-specific E2E suite is deleted because the feature no longer exists.

**Dependencies:** Task 1.

**Risks / Mitigation:** Removing the nav item will leave an unused icon import behind in `sidebar.tsx`. Clean the import in the same edit so lint stays green.

**Rollback:** Restore `src/components/layout/sidebar.tsx`, `src/app/(dashboard)/opportunities/page.tsx`, and `e2e/opportunities.spec.ts` from git if product direction changes before the API/service cleanup.

**Files:**
- Modify: `src/components/layout/sidebar.tsx`
- Delete: `src/app/(dashboard)/opportunities/page.tsx`
- Delete: `e2e/opportunities.spec.ts`
- Test: `e2e/navigation.spec.ts`

- [ ] **Step 1: Remove the Opportunities nav item and the unused icon import from `sidebar.tsx`**

```ts
const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/bills", label: "Bills", icon: FileText },
  { href: "/resources", label: "Resources", icon: Server },
  { href: "/trends", label: "Trends", icon: TrendingUp },
  { href: "/manual-costs", label: "Manual Costs", icon: PencilLine },
  { href: "/settings", label: "Settings", icon: Settings },
];
```

- [ ] **Step 2: Delete the retired dashboard page file**

Run: `git rm "src/app/(dashboard)/opportunities/page.tsx"`
Expected: the feature page is removed from the app tree.

- [ ] **Step 3: Delete the obsolete Opportunities E2E suite**

Run: `git rm "e2e/opportunities.spec.ts"`
Expected: the feature-specific E2E file is removed because the feature no longer exists.

- [ ] **Step 4: Re-run the UI retirement regression subset**

Run: `npx playwright test e2e/navigation.spec.ts --grep "retired Opportunities|sidebar does not show the retired Opportunities link"`
Expected: PASS.


---

### Task 3: Lock the retired API behavior with a failing regression test

**Deliverable / Acceptance Criteria:** Existing E2E coverage explicitly fails until `/api/v1/opportunities` is removed.

**Dependencies:** None beyond the current app shell; can be done after Task 2 so the UI retirement is already green.

**Risks / Mitigation:** Use browser-context `fetch()` from a logged-in page so the test exercises the real app origin instead of inventing a separate request client setup.

**Rollback:** Revert only the new API-retirement test if the route is intentionally restored before implementation finishes.

**Files:**
- Modify: `e2e/navigation.spec.ts`
- Test: `e2e/navigation.spec.ts`

- [ ] **Step 1: Add a failing test proving the retired Opportunities API returns `404`**

```ts
test("retired Opportunities API returns 404", async ({ page }) => {
  await page.goto("/");
  const status = await page.evaluate(async () => {
    const response = await fetch("/api/v1/opportunities");
    return response.status;
  });

  expect(status).toBe(404);
});
```

- [ ] **Step 2: Run only the new API-retirement regression**

Run: `npx playwright test e2e/navigation.spec.ts --grep "retired Opportunities API returns 404"`
Expected: FAIL because the route still exists.

---

### Task 4: Remove the Opportunities API, service module, and obsolete docs

**Deliverable / Acceptance Criteria:** The route, route test, and all `cost-governance` implementation files are deleted; obsolete design/PRD docs are deleted; the API-retirement regression passes; retained billing, settings, and sync API/service tests still pass.

**Dependencies:** Task 3.

**Risks / Mitigation:** Hidden imports are the main risk. After deleting the API and service tree, run focused verification on retained route/service suites plus a targeted source grep so missing references surface immediately.

**Rollback:** Restore the deleted route, tests, service files, and docs from git if a downstream retained module is found to depend on them.

**Files:**
- Delete: `src/app/api/v1/opportunities/route.ts`
- Delete: `src/app/api/__tests__/opportunities-route.test.ts`
- Delete: `src/services/cost-governance/index.ts`
- Delete: `src/services/cost-governance/engine.ts`
- Delete: `src/services/cost-governance/types.ts`
- Delete: `src/services/cost-governance/signals.ts`
- Delete: `src/services/cost-governance/normalizers/aws.ts`
- Delete: `src/services/cost-governance/rules/expensive-unowned-resource.ts`
- Delete: `src/services/cost-governance/rules/high-cost-service-without-clear-resource-ownership.ts`
- Delete: `src/services/cost-governance/rules/long-tail-resource-spread.ts`
- Delete: `src/services/cost-governance/rules/overprovisioned-high-baseline-compute.ts`
- Delete: `src/services/cost-governance/rules/region-or-service-cost-anomaly.ts`
- Delete: `src/services/cost-governance/rules/resource-group-cost-anomaly.ts`
- Delete: `src/services/cost-governance/rules/stopped-but-costing.ts`
- Delete: `src/services/cost-governance/rules/uncategorized-high-cost-resource.ts`
- Delete: `src/services/cost-governance/__tests__/service.test.ts`
- Delete: `src/services/cost-governance/__tests__/aws-normalizer.test.ts`
- Delete: `docs/2026-03-19-cost-governance-phase1-prd.md`
- Delete: `docs/2026-03-19-cost-governance-phase1-technical-design.md`
- Delete: `docs/2026-03-19-zombie-assessment-implementation-design.md`
- Test: `e2e/navigation.spec.ts`, `src/app/api/__tests__/routes.test.ts`, `src/app/api/__tests__/settings-routes.test.ts`, `src/services/__tests__/billing.test.ts`, `src/services/__tests__/settings.test.ts`, `src/services/__tests__/sync.test.ts`

- [ ] **Step 1: Delete the Opportunities API route and its dedicated unit test**

```bash
git rm src/app/api/v1/opportunities/route.ts src/app/api/__tests__/opportunities-route.test.ts
```

- [ ] **Step 2: Delete the entire `src/services/cost-governance/` tree**

```bash
git rm -r src/services/cost-governance
```

- [ ] **Step 3: Delete the obsolete governance and zombie design documents tied to the retired module**

```bash
git rm docs/2026-03-19-cost-governance-phase1-prd.md docs/2026-03-19-cost-governance-phase1-technical-design.md docs/2026-03-19-zombie-assessment-implementation-design.md
```

- [ ] **Step 4: Run the API-retirement regression**

Run: `npx playwright test e2e/navigation.spec.ts --grep "retired Opportunities API returns 404"`
Expected: PASS.

- [ ] **Step 5: Run focused retained-suite verification for billing, settings, and sync sentinels**

Run: `npx vitest run src/app/api/__tests__/routes.test.ts src/app/api/__tests__/settings-routes.test.ts src/services/__tests__/billing.test.ts src/services/__tests__/settings.test.ts src/services/__tests__/sync.test.ts`
Expected: PASS.


---

### Task 5: Verify the full cleanup boundary and accidental-scope guardrails

**Deliverable / Acceptance Criteria:** Only the planned files were modified or deleted, the remaining navigation regression file is green, lint on changed survivors is green, no source or live-doc references to the retired module remain, and retained billing/settings/sync sentinels still pass.

**Dependencies:** Tasks 1–4.

**Risks / Mitigation:** Broad greps can surface generated output from `.next/`. Restrict the search to tracked source/doc paths so results stay meaningful.

**Rollback:** Revert any unexpected diff hunk before the final commit if the verification commands show scope creep.

**Files:**
- Modify: none
- Test: `e2e/navigation.spec.ts`, `src/app/api/__tests__/routes.test.ts`, `src/app/api/__tests__/settings-routes.test.ts`, `src/services/__tests__/billing.test.ts`, `src/services/__tests__/settings.test.ts`, `src/services/__tests__/sync.test.ts`

- [ ] **Step 1: Verify there are no remaining runtime references in `src`**

Run: `git grep -n -E "(/opportunities|/api/v1/opportunities|cost-governance)" -- src`
Expected: no matches.

- [ ] **Step 2: Verify there are no remaining live-doc references outside this cleanup plan itself**

Run: `git grep -n -E "(/opportunities|/api/v1/opportunities|cost-governance|Opportunities|getCostGovernanceOpportunities|Zombie Assessment Module)" -- docs -- ":(exclude)docs/superpowers/plans/2026-03-22-opportunities-cleanup.md"`
Expected: no matches.

- [ ] **Step 3: Verify there are no remaining feature references in the test tree outside the intentional retirement regressions**

Run: `git grep -n -E "(/opportunities|/api/v1/opportunities|@/services/cost-governance|cost-governance|Opportunities|getCostGovernanceOpportunities)" -- e2e src`
Expected: matches only in `e2e/navigation.spec.ts` retirement test names/assertions, or no matches at all if the implementation removes those literals too.

- [ ] **Step 4: Verify there are no remaining repo-level config or script references**

Run: `git grep -n -E "(/opportunities|/api/v1/opportunities|cost-governance|Opportunities|getCostGovernanceOpportunities)" -- package.json playwright.config.ts vitest.config.ts scripts`
Expected: no matches.

- [ ] **Step 5: Run the full navigation spec**

Run: `npx playwright test e2e/navigation.spec.ts`
Expected: PASS.

- [ ] **Step 6: Run focused lint on the surviving changed files**

Run: `npx eslint src/components/layout/sidebar.tsx e2e/navigation.spec.ts`
Expected: 0 errors.

- [ ] **Step 7: Inspect the diff for accidental scope creep**

Run: `git diff -- src/components/layout/sidebar.tsx e2e/navigation.spec.ts e2e/opportunities.spec.ts "src/app/(dashboard)/opportunities/page.tsx" src/app/api/v1/opportunities/route.ts src/app/api/__tests__/opportunities-route.test.ts src/services/cost-governance docs/2026-03-19-cost-governance-phase1-prd.md docs/2026-03-19-cost-governance-phase1-technical-design.md docs/2026-03-19-zombie-assessment-implementation-design.md`
Expected: only the planned sidebar/navigation edits and the planned deletions are present.


---

## Notes for the implementer

- Do not introduce a replacement `zombie` route, API, service, or sidebar entry in this cleanup.
- Do not migrate or rename the `cost-governance` code into a new namespace. The current requirement is deletion, not transition.
- Keep the regression surface small: one surviving E2E file is enough to prove the feature is retired.
- If the deleted docs are still needed for historical context, recover them later from git history rather than leaving dead documents in the live tree.
