/*
 * Edge Function: /functions/v1/simulate
 *
 * The single backend entry point for the Investment page. The browser sends a
 * JSON body { action, ... } and receives fully-computed results — no financial
 * math runs client-side (Task 6).
 *
 * Actions:
 *   simulate     run one coin over a date range; rank every model + Buy&Hold,
 *                or (with `allocation`) simulate a weighted multi-model portfolio
 *   leaderboard  ranked table for a date range, curves stripped (lightweight)
 *   save/list/get/delete   per-user saved simulations (require a logged-in JWT)
 *
 * Prediction data is read with the service-role key. Saved simulations are read
 * and written through the caller's JWT so Postgres RLS enforces ownership.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import {
  type Allocation,
  buildLog,
  buyHold,
  type Candle,
  type LogRow,
  type PredEntry,
  rankByProfit,
  simulateModel,
  simulatePortfolio,
  stripCurves,
} from "../_shared/engine.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Model -> which prediction-history array it lives in. v2 challengers target a
// 1h horizon and are stored separately; mirrors the dashboard's MODELS config.
const MODELS = ["LSTM", "Transformer", "ARIMA", "LSTM_v2", "Transformer_v2"];
const isV2 = (m: string) => m.endsWith("_v2");
const COINS: Record<string, number> = { BTCUSDT: 1, ETHUSDT: 2, XRPUSDT: 3 };

const MAX_AMOUNT = 1e12;
const MAX_ALLOCATION_MODELS = MODELS.length;
const MAX_CURVE_POINTS = 400;

class BadRequest extends Error {}

/* ----------------------------------------------------------- validation */

function toUnix(d: unknown, fallback: number): number {
  if (d === undefined || d === null || d === "") return fallback;
  const ms = typeof d === "number" ? d * 1000 : Date.parse(String(d));
  if (!Number.isFinite(ms)) throw new BadRequest("Invalid date: " + d);
  return Math.floor(ms / 1000);
}

function parseCommon(body: Record<string, unknown>) {
  const coin = String(body.coin ?? "BTCUSDT").toUpperCase();
  if (!(coin in COINS)) throw new BadRequest("Unknown coin: " + coin);

  const amount = Number(body.initialAmount ?? 1000);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw new BadRequest("initialAmount must be between 0 and " + MAX_AMOUNT);
  }
  const fromSec = toUnix(body.startDate, -Infinity);
  const toSec = toUnix(body.endDate, Infinity);
  if (fromSec > toSec) throw new BadRequest("startDate must be before endDate");
  return { coin, amount, fromSec, toSec };
}

function parseAllocation(raw: unknown): Allocation[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (raw.length > MAX_ALLOCATION_MODELS) throw new BadRequest("Too many models in allocation");
  const alloc: Allocation[] = [];
  let total = 0;
  for (const a of raw) {
    const model = String((a as Record<string, unknown>).model ?? "");
    if (!MODELS.includes(model)) throw new BadRequest("Unknown model: " + model);
    const weight = Number((a as Record<string, unknown>).weight);
    if (!Number.isFinite(weight) || weight < 0) throw new BadRequest("Invalid weight for " + model);
    alloc.push({ model, weight });
    total += weight;
  }
  if (total <= 0) throw new BadRequest("Allocation weights sum to zero");
  // Normalise so weights always sum to 1 (accepts 40/30/30 or 0.4/0.3/0.3).
  return alloc.map((a) => ({ model: a.model, weight: a.weight / total }));
}

/* -------------------------------------------------------------- data load */

async function loadPayload(coin: string): Promise<Record<string, unknown>> {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data, error } = await admin
    .from("predictions")
    .select("payload")
    .eq("id", COINS[coin])
    .single();
  if (error || !data?.payload) throw new BadRequest("No prediction data for " + coin);
  return data.payload as Record<string, unknown>;
}

function hist5mOf(payload: Record<string, unknown>): Candle[] {
  const h = payload.history as Record<string, Candle[]> | undefined;
  return (h && h["5m"]) || [];
}

function predHistOf(payload: Record<string, unknown>, model: string): PredEntry[] {
  return (isV2(model)
    ? (payload.prediction_history_v2 as PredEntry[])
    : (payload.prediction_history as PredEntry[])) || [];
}

// Cap curve length so long ranges don't bloat the response.
function downsample<T>(arr: T[]): T[] {
  if (arr.length <= MAX_CURVE_POINTS) return arr;
  const step = Math.ceil(arr.length / MAX_CURVE_POINTS);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

/* --------------------------------------------------------- core compute */

function runSimulation(payload: Record<string, unknown>, amount: number, fromSec: number, toSec: number, allocRaw: unknown) {
  const hist5m = hist5mOf(payload);
  if (hist5m.length < 2) throw new BadRequest("Not enough price history for this asset");

  const bh = buyHold(hist5m, fromSec, toSec, amount);

  // Build every model's trade log once; reused for both single + portfolio modes.
  const logs: Record<string, LogRow[]> = {};
  for (const m of MODELS) {
    const ph = predHistOf(payload, m);
    if (!ph.length) continue;
    const log = buildLog(ph, hist5m, m, fromSec, toSec);
    if (log.length) logs[m] = log;
  }

  const present = payload.predictions as Record<string, unknown> | undefined;
  const models = rankByProfit(
    Object.keys(logs)
      .filter((m) => !present || present[m]) // only models this coin actually serves
      .map((m) => {
        const s = simulateModel(m, logs[m], amount, bh.profitPct);
        s.equityCurve = downsample(s.equityCurve);
        s.drawdownCurve = downsample(s.drawdownCurve);
        return s;
      }),
  );

  const alloc = parseAllocation(allocRaw);
  let portfolio = null;
  if (alloc) {
    const p = simulatePortfolio(alloc, logs, amount, bh.profitPct);
    p.equityCurve = downsample(p.equityCurve);
    p.drawdownCurve = downsample(p.drawdownCurve);
    portfolio = p;
  }

  const actualFrom = models.reduce(
    (mn, m) => Math.min(mn, m.equityCurve[0]?.time ?? mn),
    bh.equityCurve[0]?.time ?? fromSec,
  );
  return {
    range: { from: actualFrom, to: bh.equityCurve[bh.equityCurve.length - 1]?.time ?? toSec },
    buyHold: bh,
    models,
    portfolio,
  };
}

/* ------------------------------------------------------------- handlers */

async function userClient(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new BadRequest("Authentication required");
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) throw new BadRequest("Authentication required");
  return { client, user: data.user };
}

async function handle(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "simulate");

  switch (action) {
    case "simulate": {
      const { coin, amount, fromSec, toSec } = parseCommon(body);
      const payload = await loadPayload(coin);
      const result = runSimulation(payload, amount, fromSec, toSec, body.allocation);
      return jsonResponse({ coin, ...result });
    }

    case "leaderboard": {
      const { coin, amount, fromSec, toSec } = parseCommon(body);
      const payload = await loadPayload(coin);
      const result = runSimulation(payload, amount, fromSec, toSec, null);
      // Strip curves: the leaderboard is a pure ranking table.
      return jsonResponse({
        coin,
        range: result.range,
        buyHold: { profitPct: result.buyHold.profitPct, finalValue: result.buyHold.finalValue },
        models: result.models.map(stripCurves),
      });
    }

    case "save": {
      const { client, user } = await userClient(req);
      const name = String(body.name ?? "").trim().slice(0, 120);
      if (!name) throw new BadRequest("A name is required to save");
      const { coin, amount, fromSec, toSec } = parseCommon(body);
      const params = {
        coin,
        initialAmount: amount,
        startDate: body.startDate ?? null,
        endDate: body.endDate ?? null,
        allocation: parseAllocation(body.allocation),
      };
      // Recompute server-side so saved summaries can't be forged by the client.
      const payload = await loadPayload(coin);
      const result = runSimulation(payload, amount, fromSec, toSec, body.allocation);
      const summary = {
        models: result.models.map(stripCurves),
        buyHold: { profitPct: result.buyHold.profitPct, finalValue: result.buyHold.finalValue },
        portfolio: result.portfolio ? stripCurves(result.portfolio) : null,
      };
      const { data, error } = await client
        .from("saved_simulations")
        .insert({ user_id: user.id, name, coin, params, summary })
        .select("id, name, coin, params, summary, created_at")
        .single();
      if (error) throw new BadRequest(error.message);
      return jsonResponse({ saved: data });
    }

    case "list": {
      const { client } = await userClient(req);
      const { data, error } = await client
        .from("saved_simulations")
        .select("id, name, coin, params, summary, created_at")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw new BadRequest(error.message);
      return jsonResponse({ saved: data ?? [] });
    }

    case "delete": {
      const { client } = await userClient(req);
      const id = String(body.id ?? "");
      if (!id) throw new BadRequest("id required");
      const { error } = await client.from("saved_simulations").delete().eq("id", id);
      if (error) throw new BadRequest(error.message);
      return jsonResponse({ deleted: id });
    }

    default:
      throw new BadRequest("Unknown action: " + action);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    return await handle(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    const status = err instanceof BadRequest ? 400 : 500;
    if (status === 500) console.error("simulate error:", err);
    return jsonResponse({ error: msg }, status);
  }
});
