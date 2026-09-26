/**
 * Minimal, hand-written ABIs for the two contracts the Position / Exit-rule panel
 * touches. Only the functions and fields actually used are declared — no
 * generated artifacts. `as const` gives viem full argument and return typing.
 */

export const mockLendingPoolAbi = [
  {
    type: "function",
    name: "AVAX_PRICE_USD",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "liquidationThresholdBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "positions",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "collateral", type: "uint256" },
      { name: "debt", type: "uint256" },
      { name: "active", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "healthFactor",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "exitAgents",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "agent", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "approveExitAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agent", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "openPosition",
    stateMutability: "payable",
    inputs: [{ name: "borrowAmount", type: "uint256" }],
    outputs: [],
  },
] as const;

export const govExitAbi = [
  {
    type: "function",
    name: "rules",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "minimumThresholdBps", type: "uint256" },
      { name: "active", type: "bool" },
      { name: "triggered", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "shouldExit",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "proposalId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "setRule",
    stateMutability: "nonpayable",
    inputs: [{ name: "minimumThresholdBps", type: "uint256" }],
    outputs: [],
  },
] as const;

/**
 * The slice of `MockGovernance` the panels use. `getProposal` returns the
 * `Proposal` struct as a tuple `[id, newThresholdBps, executeAfter, state]`,
 * where `state` is the `ProposalState` enum: 0 NONE, 1 QUEUED, 2 EXECUTED,
 * 3 CANCELLED. `owner`, `queueThresholdChange`, and `setTimelock` are the
 * owner-gated Demo Admin actions (issue 15).
 */
export const mockGovernanceAbi = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "queueThresholdChange",
    stateMutability: "nonpayable",
    inputs: [{ name: "newThresholdBps", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "setTimelock",
    stateMutability: "nonpayable",
    inputs: [{ name: "newTimelockSeconds", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getProposal",
    stateMutability: "view",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "newThresholdBps", type: "uint256" },
          { name: "executeAfter", type: "uint256" },
          { name: "state", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "timelockSeconds",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** `ProposalQueued(proposalId, currentThreshold, newThreshold, executeAfter)`. */
export const proposalQueuedEvent = {
  type: "event",
  name: "ProposalQueued",
  inputs: [
    { name: "proposalId", type: "uint256", indexed: true },
    { name: "currentThreshold", type: "uint256", indexed: false },
    { name: "newThreshold", type: "uint256", indexed: false },
    { name: "executeAfter", type: "uint256", indexed: false },
  ],
} as const;

/** `ExitTriggered(user, proposalId, userMinimum, proposedThreshold)`. */
export const exitTriggeredEvent = {
  type: "event",
  name: "ExitTriggered",
  inputs: [
    { name: "user", type: "address", indexed: true },
    { name: "proposalId", type: "uint256", indexed: true },
    { name: "userMinimum", type: "uint256", indexed: false },
    { name: "proposedThreshold", type: "uint256", indexed: false },
  ],
} as const;
