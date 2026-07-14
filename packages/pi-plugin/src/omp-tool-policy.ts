export interface OmpToolPolicyInput {
	isOmpHost: boolean;
	memoryEnabled: boolean;
	ctxNoteEnabled: boolean;
}

export interface OmpToolPolicy {
	memoryToolEnabled: boolean;
	noteToolEnabled: boolean;
}

/**
 * OMP has a fixed tool registry for the lifetime of a session. Apply its
 * boot-project feature switches to that registry without changing native Pi.
 */
export function resolveOmpToolPolicy(input: OmpToolPolicyInput): OmpToolPolicy {
	return {
		memoryToolEnabled: !input.isOmpHost || input.memoryEnabled,
		noteToolEnabled: !input.isOmpHost || input.ctxNoteEnabled,
	};
}
