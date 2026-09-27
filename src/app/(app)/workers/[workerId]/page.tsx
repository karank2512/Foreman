import { cache, type ReactElement } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { requireSession } from "@/server/auth";
import { isAppError } from "@/server/errors";
import { getWorkerHeader, type WorkerHeaderView } from "@/server/queries/worker-profile";
import { WorkerHeader } from "./_components/worker-header";
import { WorkerTabNav } from "./_components/tab-nav";
import ActivityTab from "./_tabs/activity";
import ChatTab from "./_tabs/chat";
import CostTab from "./_tabs/cost";
import DebugTab from "./_tabs/debug";
import DeliverablesTab from "./_tabs/deliverables";
import OverviewTab from "./_tabs/overview";
import PerformanceTab from "./_tabs/performance";
import PermissionsTab from "./_tabs/permissions";
import VersionsTab from "./_tabs/versions";
import { loadWorkerChat } from "./_tabs/chat-data";
import { isWorkerTab, WORKER_TAB_LABELS, type WorkerTab, type WorkerTabProps } from "./_tabs/types";

interface PageProps {
  params: Promise<{ workerId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}

type TabComponent = (props: WorkerTabProps) => Promise<ReactElement> | ReactElement;

/** Each tab loads its own data through an org-scoped query and renders content only (the seam in _tabs/types.ts). */
const TAB_COMPONENTS: Record<WorkerTab, TabComponent> = {
  overview: OverviewTab,
  activity: ActivityTab,
  deliverables: DeliverablesTab,
  performance: PerformanceTab,
  cost: CostTab,
  permissions: PermissionsTab,
  chat: ChatTab,
  versions: VersionsTab,
  debug: DebugTab,
};

/** generateMetadata and the page both need the header — one DB round trip per request. */
const loadHeader = cache(async (workerId: string): Promise<WorkerHeaderView | null> => {
  const s = await requireSession();
  try {
    return await getWorkerHeader(s.organizationId, workerId, { role: s.role });
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") return null;
    throw e;
  }
});

function pickTab(raw: string | string[] | undefined): WorkerTab {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return isWorkerTab(value) ? value : "overview";
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const [{ workerId }, query] = await Promise.all([params, searchParams]);
  const worker = await loadHeader(workerId);
  if (!worker) return { title: "Worker" };
  const tab = pickTab(query.tab);
  return { title: tab === "overview" ? worker.name : `${worker.name} · ${WORKER_TAB_LABELS[tab]}` };
}

export default async function WorkerProfilePage({ params, searchParams }: PageProps) {
  const [{ workerId }, query] = await Promise.all([params, searchParams]);
  const session = await requireSession();
  const worker = await loadHeader(workerId);
  if (!worker) notFound();

  const tab = pickTab(query.tab);
  const Tab = TAB_COMPONENTS[tab];
  // Only someone who could press Run now needs to hear that the chat already queued instructions for the run.
  const queuedInstructions =
    worker.permissions["workers.run"] && worker.status === "ACTIVE"
      ? (await loadWorkerChat(session.organizationId, worker.id, session.role)).pendingInstructions
      : 0;

  return (
    <>
      <WorkerHeader worker={worker} floatingMobileActions={tab !== "chat"} queuedInstructions={queuedInstructions} />
      <WorkerTabNav workerId={worker.id} workerName={worker.name} active={tab} />
      <div key={tab} className="space-y-14 pt-10">
        <Tab session={session} workerId={worker.id} workerName={worker.name} />
      </div>
      {/* While a run is in flight the header banner, recent runs and the score can all change. */}
      <AutoRefresh active={worker.inFlightRun !== null} intervalMs={tab === "debug" ? 8000 : 4000} />
    </>
  );
}
