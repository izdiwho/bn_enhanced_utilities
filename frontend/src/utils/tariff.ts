/**
 * Brunei electricity tariff calculator.
 *
 * Residential tariff (domestic, as of 2024):
 *   First 600 kWh/month:  BND 0.01/kWh
 *   601–2000 kWh/month:   BND 0.08/kWh
 *   Above 2000 kWh/month: BND 0.10/kWh
 *
 * Water tariff (domestic, approximate):
 *   First 54.5 m³/month:  BND 0.11/m³
 *   54.5–109 m³/month:    BND 0.22/m³
 *   Above 109 m³/month:   BND 0.33/m³
 *
 * These tiers are approximations. Confirm from the official tariff schedule.
 */

export interface TariffTier {
  upTo: number;     // inclusive upper bound in units (kWh or m³); Infinity for last tier
  rate: number;     // BND per unit
}

export const ELECTRICITY_TARIFF: TariffTier[] = [
  { upTo: 600,      rate: 0.01 },
  { upTo: 2000,     rate: 0.08 },
  { upTo: Infinity, rate: 0.10 },
];

export const WATER_TARIFF: TariffTier[] = [
  { upTo: 54.5,     rate: 0.11 },
  { upTo: 109,      rate: 0.22 },
  { upTo: Infinity, rate: 0.33 },
];

/**
 * Calculate the total cost in BND for a given consumption.
 */
export function calculateCost(
  consumption: number,
  tariff: TariffTier[]
): number {
  let remaining = consumption;
  let cost = 0;
  let prev = 0;

  for (const tier of tariff) {
    if (remaining <= 0) break;
    const inTier = Math.min(remaining, tier.upTo - prev);
    cost += inTier * tier.rate;
    remaining -= inTier;
    prev = tier.upTo === Infinity ? prev : tier.upTo;
  }

  return Math.round(cost * 100) / 100;
}

/**
 * Calculate marginal cost (cost of one more unit) at the given consumption level.
 */
export function marginalRate(consumption: number, tariff: TariffTier[]): number {
  let prev = 0;
  for (const tier of tariff) {
    if (consumption <= tier.upTo) return tier.rate;
    prev = tier.upTo;
  }
  return tariff[tariff.length - 1]?.rate ?? 0;
}

/**
 * Estimate months until balance runs out.
 * Returns Infinity if avgMonthlyConsumption is 0.
 */
export function estimateMonthsRemaining(
  remainingBalance: number,
  avgMonthlyConsumption: number,
  tariff: TariffTier[]
): number {
  if (avgMonthlyConsumption <= 0) return Infinity;
  const monthlyCost = calculateCost(avgMonthlyConsumption, tariff);
  if (monthlyCost <= 0) return Infinity;
  return remainingBalance / monthlyCost;
}
