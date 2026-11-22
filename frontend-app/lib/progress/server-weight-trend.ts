/** Body-weight history for the persistent trainer client card.
 * Starting weight is a baseline without a measured date; it must not be
 * inserted into the measurements table or counted as a dated weighing.
 */
export type DatedWeight = Readonly<{ date: string; weight: number }>;

export type ServerWeightTrend = Readonly<{
  observations: ReadonlyArray<{ date: string; value: number }>;
  measurementCount: number;
  latestWeight: number;
  latestDate: string | null;
  delta: number;
}>;

export function buildServerWeightTrend(startingWeight: number, measurements: readonly DatedWeight[]): ServerWeightTrend {
  const ordered = [...measurements].sort((a, b) => a.date.localeCompare(b.date));
  const latest = ordered.at(-1);
  const latestWeight = latest?.weight ?? startingWeight;

  return {
    // Chart rendering uses the observation index, not a calendar timestamp.
    observations: [
      { date: "Старт", value: startingWeight },
      ...ordered.map(item => ({ date: item.date, value: item.weight })),
    ],
    measurementCount: ordered.length,
    latestWeight,
    latestDate: latest?.date ?? null,
    delta: Math.round((latestWeight - startingWeight) * 1000) / 1000,
  };
}
