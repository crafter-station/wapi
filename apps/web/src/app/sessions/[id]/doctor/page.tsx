import { DoctorPanel } from "@/components/doctor-panel";
import { getDoctorRun } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function DoctorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getDoctorRun(Number(id));

  return (
    <DoctorPanel
      id={Number(id)}
      previous={
        run
          ? { checks: run.checks, ranAt: run.ranAt.toISOString(), verdict: run.verdict }
          : null
      }
    />
  );
}
