import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/dal";
import { getProjectWithProfile } from "@/lib/projects/queries";
import { wizardPath } from "@/lib/wizard/steps";

/**
 * `/projects/[projectId]/wizard` — resume entry point.
 *
 * Redirects to the project's PERSISTED `current_step`, so this URL is a stable
 * "take me back to where I was" link that survives sessions and devices. If the
 * project isn't visible to the caller (missing, or another tenant's), we send
 * them to the dashboard rather than revealing which of the two it was.
 */
export default async function ProjectWizardIndexPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const [{ projectId }] = await Promise.all([params, requireUser()]);

  const result = await getProjectWithProfile(projectId);
  if (result.status !== "ok" || !result.data) redirect("/");

  redirect(wizardPath(projectId, result.data.project.current_step));
}
