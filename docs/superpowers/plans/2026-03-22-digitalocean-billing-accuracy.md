# DigitalOcean Billing Accuracy Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix DigitalOcean billing precision so historical `bill_items` reconcile with `bills.total_amount`, while keeping current-month totals when an invoice is not yet available.

**Architecture:** Keep the existing schema. Normalize duplicate DigitalOcean invoice lines inside the provider before they reach persistence, then give DigitalOcean a provider-specific sync path that rebuilds bill items per bill instead of using the generic upsert matcher. AWS behavior stays unchanged.

**Tech Stack:** TypeScript, Next.js App Router, Drizzle ORM, better-sqlite3, Vitest

---

## File Structure

### Existing files to modify

- `src/providers/digitalocean.ts`
  - Add a small normalization helper for DigitalOcean invoice items.
  - Keep current-month balance bill behavior intact.

- `src/providers/__tests__/digitalocean.test.ts`
  - Add provider-level regression coverage for duplicate line aggregation and no-invoice behavior.

- `src/services/sync.ts`
  - Add a DigitalOcean-specific bill-item sync path: delete existing items for a bill, then insert normalized replacement items.
  - Keep the existing generic upsert flow for AWS and other providers.

- `src/services/__tests__/sync.test.ts`
  - Extend DB mocks to support `db.delete(...).where(...).run()`.
  - Add sync-level regression coverage for the DigitalOcean replacement path.

### No schema / API / UI changes planned

- `src/db/schema.ts`
- `src/app/api/v1/bills/route.ts`
- `src/app/(dashboard)/bills/page.tsx`
- `src/app/(dashboard)/bills/[id]/page.tsx`

These stay untouched unless tests prove an additional change is truly required.

---

### Task 1: Lock the provider-level regression with failing tests

**Files:**
- Modify: `src/providers/__tests__/digitalocean.test.ts`
- Test: `src/providers/__tests__/digitalocean.test.ts`

- [ ] **Step 1: Write a failing test for duplicate DO invoice lines that should be aggregated**

Add a test that feeds `fetchBillItems("2026-02")` two invoice items with the same persisted identity:
- same `product`
- same `region`
- same `resource_uuid`
- same `duration_unit`
- different `start_time` / `end_time`
- different `amount`

Expected result:
- returned array length is `1`
- `amount` is the sum
- `usageQuantity` is the sum
- `startDate` is the earliest timestamp
- `endDate` is the latest timestamp

- [ ] **Step 2: Write a failing test proving missing usage quantities stay missing after aggregation**

Add a second test with two duplicate-identity invoice items where both `duration` values are missing/empty.

Expected result:
- returned array length is `1`
- `usageQuantity` is `undefined`, not `0`

- [ ] **Step 3: Run the provider test to verify it fails**

Run: `npx vitest run src/providers/__tests__/digitalocean.test.ts`
Expected: FAIL because `fetchBillItems()` currently returns both items separately.

- [ ] **Step 4: Write a failing test for the no-invoice current-month case if coverage is not explicit enough**

Add a test that:
- returns invoices for older periods only
- calls `fetchBillItems("2026-03")`
- expects `[]`

If an equivalent test already exists after Step 1, skip creating a duplicate.

- [ ] **Step 5: Re-run the provider test file**

Run: `npx vitest run src/providers/__tests__/digitalocean.test.ts`
Expected: FAIL only for the newly added regression(s), not because of syntax/setup issues.

- [ ] **Step 6: Commit**

```bash
git add src/providers/__tests__/digitalocean.test.ts
git commit -m "test: cover digitalocean bill item normalization"
```

---

### Task 2: Implement provider-side normalization in the smallest possible way

**Files:**
- Modify: `src/providers/digitalocean.ts`
- Test: `src/providers/__tests__/digitalocean.test.ts`

- [ ] **Step 1: Add a focused normalization helper in `src/providers/digitalocean.ts`**

Implement a helper that groups DigitalOcean bill items by the persisted identity fields already used downstream:
- `service`
- `region`
- `resourceId`
- `usageUnit`

For each group:
- sum `amount`
- sum `usageQuantity` when present
- keep the first non-empty `resourceName`
- keep the earliest `startDate`
- keep the latest `endDate`

Do not refactor unrelated fetch logic.

- [ ] **Step 2: Use the helper only inside `fetchBillItems()`**

After collecting paginated `invoice_items`, return the normalized array instead of the raw array.

- [ ] **Step 3: Run the provider test file**

Run: `npx vitest run src/providers/__tests__/digitalocean.test.ts`
Expected: PASS.

- [ ] **Step 4: Do a tiny refactor only if the helper naming or date-boundary logic is unclear**

Keep the file focused. No new abstractions outside this provider.

- [ ] **Step 5: Commit**

```bash
git add src/providers/digitalocean.ts src/providers/__tests__/digitalocean.test.ts
git commit -m "fix: normalize digitalocean invoice line items"
```

---

### Task 3: Lock the sync-layer regression with failing tests

**Files:**
- Modify: `src/services/__tests__/sync.test.ts`
- Test: `src/services/__tests__/sync.test.ts`

- [ ] **Step 1: Extend the DB mock to support deletes**

Add a `delete` chain to the hoisted mock state so tests can assert:
- `db.delete(table).where(condition).run()`

Keep the mock shape parallel to the existing insert/select/update chains.

- [ ] **Step 2: Write a failing test proving DO sync must delete old items before inserting replacements**

Test shape:
- provider name is `digitalocean`
- one existing bill is returned from `select().all()`
- `fetchBillItems()` returns a normalized item array
- assert that delete is called for that bill before the new items are inserted

- [ ] **Step 3: Write a failing test proving DO no longer uses the old per-item upsert matcher**

Test shape:
- provider name is `digitalocean`
- one existing bill is returned
- `fetchBillItems()` returns one item
- assert the replacement path performs bill-level delete + insert
- assert the old item-level update/matcher path is not the mechanism used for DO item persistence

If the current DB mock cannot observe this clearly, extend the mock first so the negative-path assertion is explicit instead of implied.

- [ ] **Step 4: Write a failing test proving AWS still does not use the replacement path**

Test shape:
- provider name is `aws`
- one existing bill is returned
- `fetchBillItems()` returns one item
- assert generic update/insert behavior still happens without the DO delete-and-rebuild path

- [ ] **Step 5: Run the sync test file to verify the new regressions fail**

Run: `npx vitest run src/services/__tests__/sync.test.ts`
Expected: FAIL for the new DigitalOcean-specific expectations.

- [ ] **Step 6: Commit**

```bash
git add src/services/__tests__/sync.test.ts
git commit -m "test: cover digitalocean sync item replacement"
```

---

### Task 4: Implement the DigitalOcean-specific sync path

**Files:**
- Modify: `src/services/sync.ts`
- Test: `src/services/__tests__/sync.test.ts`

- [ ] **Step 1: Add a narrow helper that replaces all bill items for one bill**

Implement a helper in `src/services/sync.ts` that:
- deletes existing `bill_items` by `billId`
- inserts each new item with the same value mapping currently used by `upsertBillItem`
- preserves resource-category enrichment logic with the same fallback semantics as the existing path (`resource category` if found, otherwise `other`; resource name fallback remains consistent too)
- reuses or extracts a local shared mapper instead of maintaining two divergent field-mapping implementations in the same file

Keep the helper local to this file.

Implementation decision:
- prefer a single transaction for `delete + rebuild` if the current DB access layer supports it without broad test churn
- if transaction support is not practical in the current mock/test setup, explicitly document that decision in code comments or commit notes and keep the helper idempotent so a follow-up sync repairs partial failure states

- [ ] **Step 2: Route only DigitalOcean through the replacement helper**

Inside the bill-items sync loop:
- if `provider.name === "digitalocean"`, call the replacement helper
- otherwise keep using `upsertBillItem()`

Do not change bills sync or resources sync behavior.

- [ ] **Step 3: Run the sync test file**

Run: `npx vitest run src/services/__tests__/sync.test.ts`
Expected: PASS.

- [ ] **Step 4: Run the provider test file again to catch integration regressions**

Run: `npx vitest run src/providers/__tests__/digitalocean.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/sync.ts src/services/__tests__/sync.test.ts src/providers/digitalocean.ts src/providers/__tests__/digitalocean.test.ts
git commit -m "fix: rebuild digitalocean bill items during sync"
```

---

### Task 5: Verify the full changed scope

**Files:**
- Modify: none
- Test: `src/providers/__tests__/digitalocean.test.ts`, `src/services/__tests__/sync.test.ts`

- [ ] **Step 1: Run both focused test files together**

Run: `npx vitest run src/providers/__tests__/digitalocean.test.ts src/services/__tests__/sync.test.ts`
Expected: PASS.

- [ ] **Step 2: Run lint on the changed files**

Run: `npx eslint src/providers/digitalocean.ts src/providers/__tests__/digitalocean.test.ts src/services/sync.ts src/services/__tests__/sync.test.ts`
Expected: 0 errors.

- [ ] **Step 3: Inspect the diff for accidental scope creep**

Run: `git diff -- src/providers/digitalocean.ts src/providers/__tests__/digitalocean.test.ts src/services/sync.ts src/services/__tests__/sync.test.ts docs/superpowers/specs/2026-03-22-digitalocean-billing-accuracy-design.md docs/superpowers/plans/2026-03-22-digitalocean-billing-accuracy.md`
Expected: only the planned provider, sync, tests, and docs changes are present.

- [ ] **Step 4: Optional real-data verification when credentials are available**

Run:
- `npx tsx scripts/sync.ts`
- `sqlite3 data/billing.db "SELECT b.provider, b.billing_period, ROUND(b.total_amount, 2), ROUND(COALESCE(SUM(i.amount), 0), 2), ROUND(b.total_amount - COALESCE(SUM(i.amount), 0), 2) FROM bills b LEFT JOIN bill_items i ON i.bill_id = b.id WHERE b.provider = 'digitalocean' GROUP BY b.id ORDER BY b.billing_period;"`

Expected:
- historical months in the configured backfill window reconcile to `0.00` diff after the repair sync
- explicitly spot-check at least one previously bad historical month from the known issue range (`2025-09` to `2026-02`) to confirm auto-repair happened through the normal sync window, not by manual DB surgery
- current month may still show a diff if no invoice exists yet; that result is acceptable only when the month has bill total but no authoritative invoice items

- [ ] **Step 5: If transaction support was added, verify the replacement helper stays atomic under failure; otherwise record the intentional non-transaction decision**

Verification options:
- preferred: add or run a targeted test proving a thrown insert path does not leave partially rebuilt DO items when transaction support exists
- fallback: if transaction support is intentionally omitted, record that the helper relies on future sync self-healing and confirm this matches the scoped design trade-off

- [ ] **Step 6: Commit**

```bash
git add src/providers/digitalocean.ts src/providers/__tests__/digitalocean.test.ts src/services/sync.ts src/services/__tests__/sync.test.ts docs/superpowers/specs/2026-03-22-digitalocean-billing-accuracy-design.md docs/superpowers/plans/2026-03-22-digitalocean-billing-accuracy.md
git commit -m "fix: improve digitalocean billing accuracy"
```

---

## Notes for the implementer

- Do not add a schema migration unless the tests prove the normalization approach is insufficient.
- Do not change the Bills API or UI unless a failing test demonstrates that the current data semantics are unusable.
- Keep AWS behavior unchanged.
- The real business rule is: **historical DigitalOcean months must reconcile; current month may legitimately have total without items until invoice issuance.**
