import type {
	BatchFailurePresentationDetails,
	BatchStepPresentationDetails,
	ToolPresentation,
} from "../contracts.js";

// Observation consumers cannot modify the assembly state or any nested evidence. Primitives,
// including branded identities such as artifact receipt keys, are already immutable leaves.
type ReadonlyEvidence<Value> = Value extends bigint | boolean | number | string | symbol
	? Value
	: Value extends object
		? { readonly [Key in keyof Value]: ReadonlyEvidence<Value[Key]> }
		: Value;

export type ToolPresentationObservation = ReadonlyEvidence<ToolPresentation>;

export type BatchStepPresentationObservation = ReadonlyEvidence<BatchStepPresentationDetails>;

export type BatchFailurePresentationObservation = ReadonlyEvidence<BatchFailurePresentationDetails>;

export interface BatchPresentedStepObservation {
	readonly details: BatchStepPresentationObservation;
	readonly nativeIndex?: number;
	readonly presentation: ToolPresentationObservation;
}
