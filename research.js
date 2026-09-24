const SOURCE_LINKS = {
  active:
    "https://docs.alpaca.markets/us/reference/mostactives-1",
  snapshots:
    "https://docs.alpaca.markets/us/reference/stocksnapshots-1",
  assets:
    "https://docs.alpaca.markets/us/v1.4.2/reference/get-v2-assets-1",
};

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function percentChange(current, previous) {
  if (!current || !previous) return null;
  return ((current - previous) / previous) * 100;
}

export function positionRecommendation(
  position,
  { stopLossPct = -8, takeProfitPct = 15 } = {},
) {
  const gainPct = toNumber(position.unrealized_plpc) * 100;

  if (gainPct <= stopLossPct) {
    return {
      action: "Review exit",
      tone: "negative",
      explanation: `The position is at or below the configured ${stopLossPct.toFixed(1)}% paper stop threshold.`,
    };
  }

  if (gainPct >= takeProfitPct) {
    return {
      action: "Consider taking profit",
      tone: "positive",
      explanation: `The position is at or above the configured ${takeProfitPct.toFixed(1)}% paper profit threshold.`,
    };
  }

  return {
    action: "Hold and monitor",
    tone: "neutral",
    explanation: "The position remains between the configured paper exit thresholds.",
  };
}

export function buildOpportunity({
  asset,
  snapshot,
  activityRank,
  researchUpdatedAt,
  feed,
}) {
  const latestTrade = snapshot?.latestTrade || snapshot?.latest_trade || null;
  const latestQuote = snapshot?.latestQuote || snapshot?.latest_quote || null;
  const minuteBar = snapshot?.minuteBar || snapshot?.minute_bar || null;
  const dailyBar = snapshot?.dailyBar || snapshot?.daily_bar || null;
  const previousDailyBar =
    snapshot?.prevDailyBar || snapshot?.prev_daily_bar || null;

  const price = toNumber(
    latestTrade?.p ?? minuteBar?.c ?? dailyBar?.c,
    NaN,
  );
  const previousClose = toNumber(previousDailyBar?.c, NaN);
  const dayOpen = toNumber(dailyBar?.o, NaN);
  const dailyChangePct = percentChange(price, previousClose);
  const intradayChangePct = percentChange(price, dayOpen);
  const bid = toNumber(latestQuote?.bp, NaN);
  const ask = toNumber(latestQuote?.ap, NaN);
  const spreadPct =
    Number.isFinite(bid) && Number.isFinite(ask) && ask > 0
      ? ((ask - bid) / ((ask + bid) / 2)) * 100
      : null;
  const volume = toNumber(dailyBar?.v, 0);
  const priceTimestamp =
    latestTrade?.t || minuteBar?.t || dailyBar?.t || researchUpdatedAt;

  if (!Number.isFinite(price) || price <= 0) return null;

  const dailyMomentum = clamp(dailyChangePct ?? 0, -10, 10) * 2.8;
  const intradayMomentum = clamp(intradayChangePct ?? 0, -5, 5) * 1.8;
  const liquidityContribution = clamp(22 - (activityRank - 1) * 0.75, 3, 22);
  const spreadPenalty = clamp((spreadPct ?? 0.5) * 8, 0, 14);
  const largeMovePenalty = Math.max(0, Math.abs(dailyChangePct ?? 0) - 8) * 1.5;
  const score = Math.round(
    clamp(
      42 +
        dailyMomentum +
        intradayMomentum +
        liquidityContribution -
        spreadPenalty -
        largeMovePenalty,
      0,
      100,
    ),
  );

  const riskRating =
    Math.abs(dailyChangePct ?? 0) >= 8 || (spreadPct ?? 0) >= 0.75
      ? "High"
      : Math.abs(dailyChangePct ?? 0) >= 4 || (spreadPct ?? 0) >= 0.35
        ? "Elevated"
        : "Moderate";

  const riskExplanation =
    riskRating === "High"
      ? "A large daily move or wide quoted spread can produce sharp reversals and difficult simulated fills."
      : riskRating === "Elevated"
        ? "The current move or quoted spread is above the dashboard's lower-risk range."
        : "The current move and quoted spread are inside the dashboard's moderate market-risk range; equity loss remains possible.";

  const reasonsFor = [];
  if ((dailyChangePct ?? 0) > 0) {
    reasonsFor.push(
      `Price is ${dailyChangePct.toFixed(2)}% above the previous close in the ${feed.toUpperCase()} snapshot.`,
    );
  }
  if ((intradayChangePct ?? 0) > 0) {
    reasonsFor.push(
      `Price is ${intradayChangePct.toFixed(2)}% above today's open.`,
    );
  }
  reasonsFor.push(
    `Ranked #${activityRank} in Alpaca's most-active stock response at the last scan.`,
  );

  const reasonsAgainst = [
    "No verified news, filing, earnings, or catalyst source is configured, so no event claim is included.",
  ];
  if (riskRating !== "Moderate") {
    reasonsAgainst.push(riskExplanation);
  }
  if (!asset.fractionable) {
    reasonsAgainst.push("This asset is not marked fractionable in Alpaca's asset catalog.");
  }

  return {
    symbol: asset.symbol,
    companyName: asset.name || asset.symbol,
    exchange: asset.exchange || "Unavailable",
    tradable: Boolean(asset.tradable),
    fractionable: Boolean(asset.fractionable),
    price,
    priceTimestamp,
    dailyChangePct,
    intradayChangePct,
    spreadPct,
    volume,
    score,
    riskRating,
    riskExplanation,
    researchConfidence: "Limited",
    confidenceExplanation:
      "Tradability and current market data are verified through Alpaca. Fundamental, filing, news, and event verification are unavailable.",
    reasonsFor,
    reasonsAgainst,
    holdingPeriod: "Estimate: 1-5 trading days for this short-term momentum screen",
    rankExplanation: `Rule-based score ${score}/100: daily and intraday price strength plus most-active rank, reduced for quoted spread and unusually large moves. This score is not a probability or forecast.`,
    researchUpdatedAt,
    eventVerification: {
      status: "Unavailable",
      explanation:
        "No news or regulatory-filing provider is configured. Automatic trading never treats an event as verified.",
    },
    sources: [
      {
        label: "Alpaca most-active stock screener",
        url: SOURCE_LINKS.active,
        verifiedAt: researchUpdatedAt,
      },
      {
        label: `Alpaca ${feed.toUpperCase()} stock snapshot`,
        url: SOURCE_LINKS.snapshots,
        verifiedAt: priceTimestamp,
      },
      {
        label: "Alpaca active tradable-stock catalog",
        url: SOURCE_LINKS.assets,
        verifiedAt: researchUpdatedAt,
      },
    ],
  };
}

export function rankOpportunities(items) {
  return items
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

