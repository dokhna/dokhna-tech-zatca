/**
 * Public compliance-test surface re-exported from
 * `@dokhna-tach/zatca`.
 *
 * The internal in-memory adapter (`_internal-memory-storage`) is
 * intentionally NOT re-exported — users wire `@dokhna-tach/zatca-
 * storage-memory` (or another adapter) for that.
 */

export type {
  ComplianceTestReport,
  ComplianceTestScenarioResult,
  RunComplianceTestsArgs,
} from "./run-tests.js";
export { runComplianceTests } from "./run-tests.js";
export type {
  ScenarioDateOverrides,
  SimplifiedCreditNoteScenarioInput,
  SimplifiedDebitNoteScenarioInput,
  SimplifiedInvoiceScenarioInput,
  StandardCreditNoteScenarioInput,
  StandardDebitNoteScenarioInput,
  StandardInvoiceScenarioInput,
} from "./test-invoices.js";
export {
  makeSimplifiedCreditNoteScenario,
  makeSimplifiedDebitNoteScenario,
  makeSimplifiedInvoiceScenario,
  makeStandardCreditNoteScenario,
  makeStandardDebitNoteScenario,
  makeStandardInvoiceScenario,
} from "./test-invoices.js";
