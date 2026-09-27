import {
  ApprovalStatus,
  DeliverableStatus,
  JobSpecStatus,
  JobStatus,
  RunStatus,
  WorkerHealth,
  WorkerStatus,
  WorkerVersionStatus,
} from "@prisma/client";
import { describe, expect, it } from "vitest";
import { AVATAR_COLORS } from "@/server/domain";
import { initialsOf } from "@/lib/initials";
import { SCORE_BAND_CLASSES, STATUS_META, TONE_CLASSES, getStatusMeta, scoreBand, statusLabel, type StatusKind } from "@/lib/status";

const ENUMS: Record<StatusKind, Record<string, string>> = {
  run: RunStatus,
  worker: WorkerStatus,
  health: WorkerHealth,
  deliverable: DeliverableStatus,
  version: WorkerVersionStatus,
  approval: ApprovalStatus,
  job: JobStatus,
  spec: JobSpecStatus,
};

describe("status metadata", () => {
  it("covers every value of every Prisma lifecycle enum — and nothing else", () => {
    for (const [kind, values] of Object.entries(ENUMS) as Array<[StatusKind, Record<string, string>]>) {
      expect(Object.keys(STATUS_META[kind]).sort(), kind).toEqual(Object.values(values).sort());
    }
  });

  it("gives every status a humanized label and a known tone", () => {
    for (const kind of Object.keys(ENUMS) as StatusKind[]) {
      for (const [status, meta] of Object.entries(STATUS_META[kind])) {
        expect(meta.label, `${kind}.${status}`).not.toMatch(/_/);
        expect(meta.label, `${kind}.${status}`).not.toBe(status);
        expect(TONE_CLASSES[meta.tone], `${kind}.${status}`).toBeDefined();
      }
    }
  });

  it("uses the agreed product language", () => {
    expect(statusLabel("run", "WAITING_FOR_APPROVAL")).toBe("Needs approval");
    expect(statusLabel("health", "NEEDS_ATTENTION")).toBe("Needs attention");
    expect(statusLabel("deliverable", "PENDING_REVIEW")).toBe("Awaiting review");
  });

  it("maps outcomes to the semantic tones", () => {
    expect(getStatusMeta("run", "SUCCEEDED").tone).toBe("success");
    expect(getStatusMeta("run", "FAILED").tone).toBe("failure");
    expect(getStatusMeta("run", "WAITING_FOR_APPROVAL").tone).toBe("attention");
    expect(getStatusMeta("run", "QUEUED").tone).toBe("idle");
    expect(getStatusMeta("run", "RUNNING")).toMatchObject({ tone: "running", pulse: true });
  });

  it("only pulses work that is in flight", () => {
    const pulsing = (Object.keys(ENUMS) as StatusKind[]).flatMap((kind) =>
      Object.entries(STATUS_META[kind])
        .filter(([, meta]) => meta.pulse)
        .map(([status]) => `${kind}.${status}`),
    );
    expect(pulsing).toEqual(["run.RUNNING"]);
  });

  it("distinguishes the same enum string across kinds", () => {
    expect(statusLabel("version", "REJECTED")).toBe("Declined");
    expect(statusLabel("deliverable", "REJECTED")).toBe("Rejected");
  });

  it("never throws on unknown values", () => {
    expect(getStatusMeta("run", "SOME_FUTURE_STATE")).toEqual({ label: "Some future state", tone: "idle" });
    expect(getStatusMeta("nope" as StatusKind, "X").tone).toBe("idle");
  });
});

describe("scoreBand", () => {
  it("bands at 80 and 65 using the rounded score", () => {
    expect(scoreBand(100)).toBe("good");
    expect(scoreBand(80)).toBe("good");
    expect(scoreBand(79.5)).toBe("good"); // displays as 80
    expect(scoreBand(79.4)).toBe("fair");
    expect(scoreBand(65)).toBe("fair");
    expect(scoreBand(64.4)).toBe("poor");
    expect(scoreBand(0)).toBe("poor");
  });

  it("has a 'none' band for missing scores", () => {
    expect(scoreBand(null)).toBe("none");
    expect(scoreBand(undefined)).toBe("none");
    expect(scoreBand(Number.NaN)).toBe("none");
    expect(SCORE_BAND_CLASSES.none.text).toContain("muted");
  });
});

describe("WorkerAvatar helpers", () => {
  it("derives initials", () => {
    expect(initialsOf("Alex")).toBe("A");
    expect(initialsOf("maya chen")).toBe("MC");
    expect(initialsOf("  Sam  van  Dyke ")).toBe("SD");
    expect(initialsOf("")).toBe("?");
  });

  it("has a static class for every domain avatar colour (guards the Tailwind class map)", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/components/worker-avatar.tsx", import.meta.url), "utf8"),
    );
    // Each token maps to a full static `bg-<hue>-100 text-<hue>-[78]00` pair. The hue may differ from the token
    // (violet/indigo are frozen domain names that render in non-purple pastels), but it is never purple.
    for (const color of AVATAR_COLORS) {
      const entry = source.match(new RegExp(`\\b${color}: "bg-([a-z]+)-100 text-([a-z]+)-[78]00"`));
      expect(entry, color).not.toBeNull();
      expect(entry?.[1], color).toBe(entry?.[2]);
      expect(entry?.[1], color).not.toMatch(/^(violet|indigo|purple|fuchsia)$/);
    }
  });
});
