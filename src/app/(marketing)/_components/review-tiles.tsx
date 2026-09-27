import { MarketingSection, reveal } from "./section";
import { CompareMock, ScoreTrendMock } from "./mock-small";

const TILES = [
  {
    title: "Performance reviews, not guesswork.",
    body: "Scores for accuracy, completeness, and usefulness, tracked across every run. Spot a slide before it becomes a problem.",
    mock: <ScoreTrendMock />,
  },
  {
    title: "Not working out? Replace them.",
    body: "Propose an improved version, compare it side by side, and switch over. The full history stays on file.",
    mock: <CompareMock />,
  },
];

export function ReviewTiles() {
  return (
    <MarketingSection tone="gray">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {TILES.map((tile, index) => (
          <div
            key={tile.title}
            {...reveal(index)}
            className="flex min-w-0 flex-col rounded-3xl bg-card p-8 shadow-card sm:p-10"
          >
            <h2 className="text-title-2 max-w-[18ch]">{tile.title}</h2>
            <p className="mt-3 max-w-[42ch] text-[17px] leading-[25px] text-muted-foreground">{tile.body}</p>
            <div className="mt-8">{tile.mock}</div>
          </div>
        ))}
      </div>
    </MarketingSection>
  );
}
