import { redirect } from "next/navigation";

/**
 * `/projects/[projectId]` has no surface of its own in Phase 2A — the wizard is
 * the only thing a project contains. Forward to the resume entry point, which
 * resolves the persisted step. (Future project-level pages, e.g. settings,
 * would replace this.)
 */
export default async function ProjectIndexPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/wizard`);
}
