# Payroll Bulk Selection & Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow hotel operators and managers to select multiple or all posted payroll runs using individual checkboxes and a "Select All" toggle, and batch-delete the selected entries with full confirmation safety, financial impact warnings, and reactive UI feedback.

**Architecture:** 
- Add selection state (`selectedRunIds`) in `src/pages/Payroll.jsx`.
- Render a header "Select All" toggle button and an informative bulk action bar when one or more entries are selected (`X of N selected · $Y total | Clear Selection | Delete Selected (X)`).
- Render a `Checkbox` on each payroll run row with visual highlight on selected rows.
- Wire bulk deletion to `db.entities.PayrollRun.bulkDelete(ids)` wrapped with `guardDestructiveAction` to enforce CSRF validation, rate limiting, and an explicit breakdown of committed payroll (approved/paid) and total dollars removed before executing.
- Invalidate the `["payroll"]` query cache (`invalidateMoney()`) and trigger audio/toast cues upon completion.

**Tech Stack:** React 18, Radix UI Checkbox (`@/components/ui/checkbox`), Executive UI Button (`@/components/ui-exec/Button`), Executive UI Card (`@/components/ui-exec/Card`), `guardDestructiveAction` (`@/lib/deleteGuard`), `@base44/sdk` (`db.entities.PayrollRun.bulkDelete`), Vitest + `@testing-library/react`.

**Spec:** User request: "creat a button here to seleact all the entrys and detliat all seleacted entiry like if i want to detlee more than 1 or more payroll already posted"

## Global Constraints
- Preserve DIVYESH V3 governance: do NOT modify any file listed in `PROTECTED_FILES.md`.
- Never guess, only prove: test all logic using Vitest and verify manifest with `npm run verify:v3`.
- Financial integrity: Money is integer cents or exact decimal (`money2`, `sumCents`). Deletion must explicitly inform the operator about committed pay impacts on "Money Kept".
- Accessible & design-token aligned: Use existing design tokens (`var(--brand)`, `var(--danger-line)`, `var(--data-negative)`), proper `aria-label` attributes, and non-colour cues.

---

### Task 1: Unit & Regression Tests for Bulk Selection and Multi-Delete

**Files:**
- Create: `src/pages/PayrollBulkDelete.test.jsx`

**Interfaces:**
- Consumes: `guardDestructiveAction` from `@/lib/deleteGuard`, `money2` from `@/lib/hotel`, `db` from `@/api/base44Client`.
- Produces: Test suite validating:
  1. Multi-select toggle additions and removals.
  2. Select all / deselect all behavior across available entries.
  3. Total pay and committed pay (approved/paid) calculation for selected entries.
  4. Guard destructive action invocation with proper warnings when committed runs are selected.
  5. Bulk deletion execution via `db.entities.PayrollRun.bulkDelete`.
  6. Abort behavior when the user cancels the confirmation dialog.

- [ ] **Step 1: Write test suite**
Create `src/pages/PayrollBulkDelete.test.jsx` with tests simulating selection state transitions and the bulk deletion handler contract.

- [ ] **Step 2: Run test to verify initial status**
Run: `npx vitest run src/pages/PayrollBulkDelete.test.jsx`
Expected: PASS once test fixtures and contract assertions are in place.

- [ ] **Step 3: Commit**
```bash
git add src/pages/PayrollBulkDelete.test.jsx
git commit -m "test(payroll): add unit and regression tests for bulk delete and selection"
```

---

### Task 2: Add Selection State and Row Checkboxes in Payroll.jsx

**Files:**
- Modify: `src/pages/Payroll.jsx`

**Interfaces:**
- Consumes: `Checkbox` from `@/components/ui/checkbox`, `Trash2` from `lucide-react`, `Button` from `@/components/ui-exec/Button`.
- Produces:
  - `selectedRunIds`: array of selected `PayrollRun.id`s.
  - `handleToggleSelectAll()`: selects all items in `payroll` or deselects all if all are already selected.
  - `handleToggleSelectOne(id)`: toggles single row selection.
  - `handleClearSelection()`: resets selection to `[]`.
  - Header "Select All" / "Deselect All" button in Card `right` prop.
  - Individual `<Checkbox>` on each row in `payroll.map(...)`.
  - Selected row styling highlight (`border-red-500/30 bg-red-500/[0.04]`).

- [ ] **Step 1: Add selection state and toggle handlers to Payroll component**
```javascript
const [selectedRunIds, setSelectedRunIds] = useState([]);
const [isDeletingSelected, setIsDeletingSelected] = useState(false);

const validSelectedIds = selectedRunIds.filter((id) => payroll.some((p) => p.id === id));
const isAllSelected = payroll.length > 0 && validSelectedIds.length === payroll.length;

const handleToggleSelectAll = () => {
  if (isAllSelected) {
    setSelectedRunIds([]);
  } else {
    setSelectedRunIds(payroll.map((p) => p.id));
  }
};

const handleToggleSelectOne = (id) => {
  setSelectedRunIds((prev) =>
    prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
  );
};

const handleClearSelection = () => {
  setSelectedRunIds([]);
};
```

- [ ] **Step 2: Render "Select All" in Card header**
Update Card `right` prop to include a "Select All" / "Deselect All" button when `payroll.length > 0`:
```javascript
right={
  <div className="flex items-center gap-2">
    {payroll.length > 0 && (
      <Button
        variant={isAllSelected ? "secondary" : "soft"}
        size="sm"
        onClick={handleToggleSelectAll}
        className="fx-clickable text-xs"
        title={isAllSelected ? "Deselect all payroll runs" : "Select all payroll runs"}
      >
        {isAllSelected ? "Deselect All" : "Select All"}
      </Button>
    )}
    <Button variant="primary" size="sm" onClick={() => setShowForm(true)} className="fx-clickable">
      <Plus /> Add Entry
    </Button>
  </div>
}
```

- [ ] **Step 3: Render Bulk Action Banner above the payroll list**
When `validSelectedIds.length > 0`, render:
```javascript
{validSelectedIds.length > 0 && (
  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-500/25 bg-red-500/[0.06] px-4 py-2.5 mb-3 animate-in fade-in duration-150">
    <div className="flex items-center gap-2.5">
      <span className="flex h-2 w-2 rounded-full bg-red-400 animate-pulse" />
      <span className="text-xs font-semibold text-white">
        {validSelectedIds.length} of {payroll.length} selected
      </span>
      <span className="text-xs text-slate-300">
        · {money2(selectedTotalPay)} total pay
      </span>
    </div>
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="xs"
        onClick={handleClearSelection}
        className="text-xs text-slate-400 hover:text-white"
      >
        Clear Selection
      </Button>
      <Button
        variant="danger"
        size="xs"
        onClick={handleDeleteSelected}
        disabled={isDeletingSelected}
        className="gap-1.5"
      >
        <Trash2 className="h-3.5 w-3.5" />
        {isDeletingSelected ? "Deleting..." : `Delete Selected (${validSelectedIds.length})`}
      </Button>
    </div>
  </div>
)}
```

- [ ] **Step 4: Render Checkbox on each payroll run row**
```javascript
<Checkbox
  checked={isSelected}
  onCheckedChange={() => handleToggleSelectOne(p.id)}
  aria-label={`Select payroll run for ${p.employee_name || "employee"}`}
  className="border-white/20 data-[state=checked]:bg-[#6C63FF] data-[state=checked]:border-[#6C63FF]"
/>
```

- [ ] **Step 5: Verify UI build and hot reload**
Run `npm run build` or inspect via vitest.

---

### Task 3: Implement Bulk Delete Logic with Destructive Guard and Financial Safeguards

**Files:**
- Modify: `src/pages/Payroll.jsx`

**Interfaces:**
- Consumes: `guardDestructiveAction`, `db.entities.PayrollRun.bulkDelete`, `invalidateMoney`, `toast`, `sfx`.
- Produces: `handleDeleteSelected` async function.

- [ ] **Step 1: Implement `handleDeleteSelected`**
```javascript
const handleDeleteSelected = async () => {
  const selectedRuns = payroll.filter((p) => validSelectedIds.includes(p.id));
  if (!selectedRuns.length) return;

  const totalSelectedPay = selectedRuns.reduce((sum, r) => sum + (Number(r?.total_pay) || 0), 0);
  const committedRuns = selectedRuns.filter(
    (r) => r?.payroll_status === "approved" || r?.payroll_status === "paid"
  );
  const committedTotal = committedRuns.reduce((sum, r) => sum + (Number(r?.total_pay) || 0), 0);

  const lines = [
    `${selectedRuns.length} run(s) totaling ${money2(totalSelectedPay)}.`,
    committedRuns.length > 0
      ? `This includes ${committedRuns.length} approved/paid run(s) totaling ${money2(committedTotal)}. Deleting them removes pay already committed and will increase reported Money Kept by ${money2(committedTotal)}.`
      : "None of these runs are approved or paid, so Money Kept will not change.",
  ];

  const gate = guardDestructiveAction({
    title: `Delete ${selectedRuns.length} selected payroll run${selectedRuns.length === 1 ? "" : "s"}?`,
    lines,
  });

  if (!gate.ok) {
    if (gate.message) toast.error(gate.message);
    return;
  }

  try {
    setIsDeletingSelected(true);
    await db.entities.PayrollRun.bulkDelete(validSelectedIds);
    gate.complete();
    sfx.pop();
    invalidateMoney();
    toast.success(`Deleted ${selectedRuns.length} payroll run(s).`);
    setSelectedRunIds([]);
  } catch (e) {
    sfx.error();
    toast.error(`Could not delete selected payroll runs: ${e?.message || e}. Nothing was removed.`);
  } finally {
    setIsDeletingSelected(false);
  }
};
```

- [ ] **Step 2: Run tests to verify bulk delete execution**
Run: `npx vitest run src/pages/PayrollBulkDelete.test.jsx`
Expected: PASS

---

### Task 4: Final Verification and System Drift Check

**Files:**
- Verify: `src/pages/Payroll.jsx`, `src/pages/PayrollBulkDelete.test.jsx`

- [ ] **Step 1: Run full test suite for payroll**
Run: `npx vitest run src/pages/PayrollStatusRegression.test.jsx src/pages/PayrollBulkDelete.test.jsx`
Expected: PASS

- [ ] **Step 2: Run DIVYESH V3 verification**
Run: `npm run verify:v3`
Expected: PASS (no drift, canonical manifest clean)

- [ ] **Step 3: Run project build check**
Run: `npm run build`
Expected: Build succeeds with 0 errors
