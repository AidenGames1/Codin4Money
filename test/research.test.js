import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOpportunity,
  positionRecommendation,
  rankOpportunities,
} from "../research.js";

test("opportunity scoring uses verified market fields without probabilities", () => {
  const opportunity = buildOpportunity({
    asset: {
      symbol: "TEST",
      name: "Test Company",
      exchange: "NASDAQ",
      tradable: true,
      fractionable: true,
    },
    snapshot: {
      latestTrade: { p: 105, t: "2026-01-01T15:00:00Z" },
      latestQuote: { bp: 104.95, ap: 105.05 },
      dailyBar: { o: 102, v: 1000000 },
      prevDailyBar: { c: 100 },
    },
    activityRank: 2,
    researchUpdatedAt: "2026-01-01T15:00:01Z",
    feed: "iex",
  });

  assert.equal(opportunity.symbol, "TEST");
  assert.equal(opportunity.dailyChangePct, 5);
  assert.match(opportunity.rankExplanation, /not a probability/i);
  assert.equal(opportunity.eventVerification.status, "Unavailable");
});

test("ranking is descending and position rules respect configured limits", () => {
  const ranked = rankOpportunities([
    { symbol: "LOW", score: 20 },
    { symbol: "HIGH", score: 80 },
  ]);
  assert.equal(ranked[0].symbol, "HIGH");
  assert.equal(ranked[0].rank, 1);

  assert.equal(
    positionRecommendation({ unrealized_plpc: "-0.09" }).action,
    "Review exit",
  );
  assert.equal(
    positionRecommendation({ unrealized_plpc: "0.16" }).action,
    "Consider taking profit",
  );
});

