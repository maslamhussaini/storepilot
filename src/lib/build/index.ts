// Placeholder store-build/job boundary. Phase 1 drives progress via a client-side
// interval; this module defines the shape a real job-queue/polling client would
// implement in Phase 2 (e.g. pollBuildStatus(jobId)).

export type BuildStage = "queued" | "in_progress" | "complete" | "failed";

export interface BuildStatus {
  stage: BuildStage;
  percent: number;
  resource: string;
}

/** Stub for a future real job-status poll. Not called in Phase 1 (demo timer is used instead). */
export async function pollBuildStatus(jobId: string): Promise<BuildStatus> {
  void jobId;
  return { stage: "queued", percent: 0, resource: "products" };
}
