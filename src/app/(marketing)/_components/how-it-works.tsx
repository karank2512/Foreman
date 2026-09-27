import type { ReactNode } from "react";
import { MarketingSection, SectionIntro, reveal } from "./section";
import { BriefMock, CandidateMock, DeliverableMock } from "./mock-small";

const STEPS: { title: string; body: string; mock: ReactNode }[] = [
  {
    title: "Write the brief.",
    body: "A few sentences is enough. We'll ask a couple of sharp questions, then turn it into a clear job spec you can edit.",
    mock: <BriefMock />,
  },
  {
    title: "Hire your worker.",
    body: "Review a candidate's skills, tools, and expected cost before they start. Approve, and they're on the schedule.",
    mock: <CandidateMock />,
  },
  {
    title: "Review the work.",
    body: "Each run produces a deliverable you can read, rate, and send back. Scores build up into an honest performance record.",
    mock: <DeliverableMock />,
  },
];

export function HowItWorks() {
  return (
    <MarketingSection id="how" tone="gray">
      <SectionIntro title="Three steps from idea to output." />

      <ol className="mt-16 grid grid-cols-1 gap-10 md:grid-cols-3 md:gap-8">
        {STEPS.map((step, index) => (
          <li key={step.title} {...reveal(index)} className="flex min-w-0 flex-col">
            <p className="text-[48px] leading-none font-semibold tracking-[-0.02em] text-tertiary tabular-nums">
              {index + 1}
            </p>
            <h3 className="text-title-3 mt-4">{step.title}</h3>
            <p className="mt-2 text-[17px] leading-[25px] text-muted-foreground">{step.body}</p>
            <div className="mt-6">{step.mock}</div>
          </li>
        ))}
      </ol>
    </MarketingSection>
  );
}
