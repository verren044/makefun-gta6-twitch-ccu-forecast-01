// gta6-twitch-ccu-forecast-01's entry (Node 22, standard library only):
// forecast GTA VI's launch-day Twitch viewers hour by hour from the launch
// curves of past console games.
//
// The idea. A launch day's shape is a ratio curve: each hour's viewers
// divided by hour 1's print. The comparables in the case file are past big
// launches with hourly curves from 14 days before their release day to 3 days
// after it, so every comparable gives one ratio curve. Work in log space,
// where a ratio curve is a list of log-ratios ln(viewers_h / viewers_1).
//
// Which comparables count. Only console-only launches (their `platforms`
// names no PC). GTA VI releases on PlayStation 5 and Xbox Series X|S,
// single-player, unlocking at midnight local time country by country, so the
// UTC day holds the unlock in most of the world and the US unlocks hours
// after hour 1 (east coast 05:00Z, west coast 08:00Z). A console-only launch
// ramps through the day as each region unlocks; a launch with a PC
// simultaneous global unlock already holds the whole world in hour 1 and
// stays flat. Mixing the two flattens the forecast. The Grand Theft Auto VI
// category's own history is not a launch (its day is the 2026-08-27
// premiere), and it has no hour-1 print on that day, so it drops out of the
// pool on its own. A comparable needs an hour-1 print above 0.
//
// The forecast. For each hour h = 2..24, take the log-ratios of the pool at
// that hour and summarise their distribution with two numbers:
//   centre = the 60th percentile of the log-ratios,
//   spread = the interquartile range / 1.349 (the normal sigma the IQR
//            implies), floored at 0.10, then widened 1.5x.
// The centre sits above the median on purpose: console launches ramp harder
// than the median launch, and GTA VI's US-heavy console-only audience puts
// it above the median comparable. The widening is honesty about a small,
// heterogeneous pool: with 8-12 console curves, the raw IQR understates how
// far a launch day can run from the pack. Then, with p1 hour 1's print
// (below 1 counts as 1) and z the standard normal's quantile at each level
// (-1.645, -0.674, 0, 0.674, 1.645):
//   q_tau(h) = p1 * exp(centre_h + z_tau * spread_h), rounded to 2 decimals.
// Quantiles are non-decreasing by construction and clamped to [1, 1e9].
// An hour with too few ratios (fewer than 5) borrows the summary of the
// nearest hour that has one, preferring the earlier hour on a tie: launch
// days change slowly, so the hour just before is the closest analogue, and
// it is far more informative than a flat baseline. Only a pool with no usable
// hour at all falls back to the house baseline's shape for that hour
// (centre 0, spread 0.15*sqrt(h-1)).
//
// What it scored. Validated on the kit's four practice cases with a local
// pinball-loss scorer (the kit's grade-local refuses: the scorer stays on
// the server), the practice answers taken from the contest's own documented
// source, SullyGnome's hourly Twitch category averages, hour 1's print
// matching the case files exactly: mean loss 0.264 over the four cases
// (per case 0.43 / 0.16 / 0.23 / 0.24), 90% coverage 0.91, against the
// house baseline's 0.387 (per case 0.74 / 0.29 / 0.21 / 0.30). The practice
// is graded on past launches anyone can look up and pays nothing, so a
// practice score is no guide to the final; it is the check that the method
// beats the baseline it has to beat for a prize.
//
// It runs offline, with no network, under the case's time cap: everything it
// knows is in the case file. Deterministic: the same case file always gives
// the same bytes (no randomness, no clock, no network; comparables are read
// in file order and every summary sorts its values first).
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Centre of the log-ratio distribution: the 60th percentile, not the median. */
const CENTRE_Q = 0.6;
/** How much the IQR-implied spread is widened for a small, mixed pool. */
const SPREAD_WIDEN = 1.5;
/** Floor on the spread, in natural-log units. */
const SPREAD_FLOOR = 0.1;
/** The house baseline's spread, used only when an hour has too few ratios. */
const FALLBACK_SIGMA = 0.15;

interface CasePoint {
  hour: number;
  viewers: number;
}

interface Comparable {
  platforms?: string;
  hourly: Array<{ from: string; viewers: number | null }>;
  day_start: string;
}

interface Case {
  levels: number[];
  known: CasePoint[];
  forecast: Array<{ hour: number }>;
  history: Array<{ viewers: number }>;
  comparables: Comparable[];
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** The q-th quantile of values by linear interpolation (same as numpy's default). */
const quantile = (values: number[], q: number): number => {
  const v = [...values].sort((a, b) => a - b);
  const pos = q * (v.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, v.length - 1);
  const f = pos - lo;
  return v[lo] * (1 - f) + v[hi] * f;
};

/** True when a comparable is a console-only launch (no PC in its platforms). */
const isConsoleOnly = (c: Comparable): boolean =>
  !((c.platforms ?? '').toUpperCase().includes('PC'));

/** A comparable's release-day curve: {hour 1..24: viewers}, whole hours only. */
const dayCurve = (c: Comparable): Map<number, number> => {
  const curve = new Map<number, number>();
  const day = Date.parse(c.day_start);
  if (Number.isNaN(day)) return curve;
  for (const p of c.hourly ?? []) {
    if (p.viewers === null || p.viewers === undefined || p.viewers <= 0) continue;
    const t = Date.parse(p.from);
    if (Number.isNaN(t)) continue;
    const dh = (t - day) / 3600000;
    if (dh >= 0 && dh < 24) curve.set(Math.floor(dh) + 1, p.viewers);
  }
  return curve;
};

/** The five quantiles of one hour: p1 times the log-ratio distribution. */
const hourQuantiles = (p1: number, h: number, summary: { centre: number; spread: number } | undefined): number[] => {
  const centre = summary === undefined ? 0 : summary.centre;
  const spread = summary === undefined ? FALLBACK_SIGMA * Math.sqrt(h - 1) : summary.spread;
  const qs = Z.map((z) => p1 * Math.exp(centre + z * spread));
  // Round, clamp, and keep the row non-decreasing (rounding can tie neighbours).
  let prev = 1;
  return qs.map((q) => {
    const v = Math.min(1e9, Math.max(prev, round2(q)));
    prev = v;
    return v;
  });
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  const first = c.known.find((k) => k.hour === 1);
  let p1 = first === undefined ? 0 : first.viewers;
  if (!(p1 > 0)) {
    const last = (c.history ?? []).filter((p) => p.viewers > 0).at(-1);
    p1 = last === undefined ? 1 : last.viewers;
  }
  p1 = Math.max(1, p1);

  // The pool: console-only comparables with an hour-1 print, as log-ratios.
  const ratiosByHour = new Map<number, number[]>();
  for (const comp of c.comparables ?? []) {
    if (!isConsoleOnly(comp)) continue;
    const curve = dayCurve(comp);
    const p = curve.get(1);
    if (p === undefined || p <= 0) continue;
    for (const [h, v] of curve) {
      if (h < 2 || h > 24) continue;
      const list = ratiosByHour.get(h) ?? [];
      list.push(Math.log(v / p));
      ratiosByHour.set(h, list);
    }
  }

  // Per-hour summaries, from the hours with enough ratios; a sparse hour
  // borrows the nearest hour's summary, preferring the earlier hour on a tie.
  const summaries = new Map<number, { centre: number; spread: number }>();
  for (const [h, ratios] of ratiosByHour) {
    if (ratios.length < 5) continue;
    const centre = quantile(ratios, CENTRE_Q);
    const iqr = quantile(ratios, 0.75) - quantile(ratios, 0.25);
    summaries.set(h, { centre, spread: Math.max(iqr / 1.349, SPREAD_FLOOR) * SPREAD_WIDEN });
  }
  const nearestSummary = (h: number): { centre: number; spread: number } | undefined => {
    if (summaries.has(h)) return summaries.get(h);
    for (let d = 1; d < 24; d++) {
      const earlier = summaries.get(h - d);
      if (earlier !== undefined) return earlier;
      const later = summaries.get(h + d);
      if (later !== undefined) return later;
    }
    return undefined;
  };

  const hours = c.forecast.map(({ hour }) => ({
    hour,
    q: hourQuantiles(p1, hour, nearestSummary(hour)),
  }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
