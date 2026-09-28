// WHY: context records transmit only source summaries; fitted and full bodies
// stay in the host's startup inventory until one captured row is requested.
export interface ProjectInstructionSummary {
  path: string;
  truncated: boolean;
  note?: string | null;
}
