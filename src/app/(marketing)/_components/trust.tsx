import { MarketingSection, SectionIntro, reveal } from "./section";

/**
 * Only claims that are true of the shipped product: role checks and tool permissions run in
 * `@/server/auth/permissions` and `tools.invoke()`, approvals block a run mid-flight, every query is scoped by
 * `organizationId`, security events and tool traces are recorded, credentials are AES-256-GCM encrypted
 * (docs/SECURITY.md), monthly budgets stop work once they're reached, and every run carries its cost.
 * No uptime numbers, no certifications, no customer counts.
 */
const ITEMS: { title: string; body: string }[] = [
  {
    title: "Permissions enforced on our servers",
    body: "What a worker may touch is checked on every action, not just hidden in the interface. Roles decide what a person can do, too.",
  },
  {
    title: "Approval before sensitive steps",
    body: "Mark an action as sensitive and the run stops there, shows you the draft, and waits for a person to decide.",
  },
  {
    title: "Your workspace, walled off",
    body: "Every record belongs to one organization, and every read and write is scoped to it before it reaches the database.",
  },
  {
    title: "A complete audit trail",
    body: "Runs, tool calls, approvals, sign-ins and settings changes are all recorded, with who did what and when.",
  },
  {
    title: "Secrets stay secret",
    body: "Credentials are encrypted at rest, bound to your workspace, and never shown again after you add them.",
  },
  {
    title: "Spending you can cap",
    body: "Every run is priced to the cent, and a monthly limit stops the work before a surprise bill does.",
  },
];

export function Trust() {
  return (
    <MarketingSection id="security" tone="white">
      <SectionIntro
        title="Built to be trusted with real work."
        description="Your workers act on your behalf, so the guardrails are part of the product, not an add-on."
      />

      <div className="mt-16 grid grid-cols-1 gap-x-12 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
        {ITEMS.map((item, index) => (
          <div key={item.title} {...reveal(index % 3)} className="min-w-0">
            <h3 className="text-title-3">{item.title}</h3>
            <p className="mt-2 text-[15px] leading-[22px] text-muted-foreground">{item.body}</p>
          </div>
        ))}
      </div>
    </MarketingSection>
  );
}
