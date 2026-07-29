#!/usr/bin/env python
"""Replay the local prediction journal into Supabase.

The engine journals every prediction to data/predictions_{SYMBOL}.jsonl before
it pushes (see journal_prediction), precisely so a DB outage costs nothing. That
guarantee is only real if something can put the journal BACK — this is that
something.

    python serving/replay_journal.py --verify          # compare journal vs DB, change nothing
    python serving/replay_journal.py --dry-run         # show what a restore would add
    python serving/replay_journal.py                   # restore (asks first)
    python serving/replay_journal.py --coin BTCUSDT --since 2026-07-12

Merge semantics: the journal is authoritative for the two prediction-history
series and nothing else. Every other key in the payload (candles, the live
`predictions` block, chosen_model) is left exactly as the DB has it. Within a
series, entries are merged by `time`; on a collision the DB value is kept unless
--prefer-journal is passed, since a value that already survived a push is the
one the dashboard has been scoring against.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')

# Must match COINS in inference_orchestrator.py (symbol -> payload row id).
COINS = [("BTCUSDT", 1), ("ETHUSDT", 2), ("XRPUSDT", 3)]
SERIES = {'legacy': 'prediction_history', 'v2': 'prediction_history_v2'}
# Journal bookkeeping, never part of a history entry. `src` marks rows pulled back
# from the DB by --snapshot; stripping it here is what keeps a restored payload
# identical to the original rather than carrying our provenance tag into the site.
META_KEYS = {'series', 'db_id', 'written_at', 'src'}


def get_supabase():
    from supabase import create_client
    creds_path = os.path.join(BASE_DIR, 'secrets', 'supabase_creds.json')
    if not os.path.exists(creds_path):
        sys.exit(f"No Supabase credentials at {creds_path}")
    creds = json.load(open(creds_path))
    return create_client(creds['url'], creds['key'])


def read_journal(symbol, since=None, until=None):
    """Journal -> {series: {time: entry}}. Later lines win, which is what makes
    the re-journalled hourly forecasts (same target, written every 5-min cycle)
    collapse cleanly instead of duplicating."""
    path = os.path.join(DATA_DIR, f'predictions_{symbol}.jsonl')
    out = {'legacy': {}, 'v2': {}}
    if not os.path.exists(path):
        return out, 0
    corrupt = 0
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            corrupt += 1
            continue
        series = rec.get('series')
        t = rec.get('time')
        if series not in out or not isinstance(t, int):
            corrupt += 1
            continue
        if (since and t < since) or (until and t > until):
            continue
        entry = {k: v for k, v in rec.items() if k not in META_KEYS and v is not None}
        out[series][t] = entry
    return out, corrupt


def fetch_payload(supabase, db_id):
    res = supabase.table('predictions').select('payload').eq('id', db_id).execute()
    if not res.data:
        return None
    return res.data[0].get('payload') or {}


def summarize(name, journal, db_times):
    j_times = set(journal)
    missing = sorted(j_times - db_times)
    line = (f"      {name:<22} journal={len(j_times):<6} db={len(db_times):<6} "
            f"missing_from_db={len(missing)}")
    if missing:
        lo = datetime.fromtimestamp(missing[0], timezone.utc)
        hi = datetime.fromtimestamp(missing[-1], timezone.utc)
        line += f"   [{lo:%Y-%m-%d %H:%M} .. {hi:%Y-%m-%d %H:%M} UTC]"
    print(line)
    return missing


def snapshot(args):
    """Back-fill the local journal from the DB.

    Journalling only started 2026-07-17, so everything the engine predicted before
    that lives in Supabase and nowhere else — a DB loss would take it with no way
    back. This pulls those entries down into the same journal files, marked
    `src: db-snapshot` so a replayed row is never mistaken for one written live
    at prediction time. Only times the journal lacks are written, so it is safe
    to re-run and it can never clobber a live-journalled prediction.
    """
    supabase = get_supabase()
    coins = [(s, i) for s, i in COINS if not args.coin or s in args.coin]
    stamp = datetime.now(timezone.utc).isoformat()
    print(f"\nSNAPSHOT  ·  Supabase -> journal\n{'=' * 78}")
    grand = 0
    for symbol, db_id in coins:
        journal, _ = read_journal(symbol)
        payload = fetch_payload(supabase, db_id)
        if payload is None:
            print(f"\n  {symbol}: no payload row (id={db_id}) — skipping")
            continue
        path = os.path.join(DATA_DIR, f'predictions_{symbol}.jsonl')
        added, lines = 0, []
        for series, key in SERIES.items():
            have = set(journal[series])
            for row in (payload.get(key) or []):
                t = row.get('time')
                if not isinstance(t, int) or t in have:
                    continue
                rec = {k: v for k, v in row.items() if v is not None}
                rec.update({"series": series, "db_id": db_id,
                            "written_at": stamp, "src": "db-snapshot"})
                lines.append(json.dumps(rec))
                added += 1
        print(f"\n  {symbol}: {added} entries missing from the journal")
        if added and not (args.dry_run or args.verify):
            with open(path, 'a') as f:
                f.write("\n".join(lines) + "\n")
                f.flush()
                os.fsync(f.fileno())
            print(f"      => appended to {os.path.relpath(path, BASE_DIR)}")
        elif added:
            print("      => (dry run, nothing written)")
        grand += added
    print(f"\n{'=' * 78}")
    print(f"{grand} entries {'would be' if (args.dry_run or args.verify) else ''} "
          f"backed up locally.\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--coin', action='append', help='symbol to process (repeatable); default all')
    ap.add_argument('--verify', action='store_true', help='compare only, never write')
    ap.add_argument('--dry-run', action='store_true', help='show the merge result, never write')
    ap.add_argument('--prefer-journal', action='store_true',
                    help='on a time collision, overwrite the DB entry with the journal one')
    ap.add_argument('--since', help='ignore journal entries before this UTC date (YYYY-MM-DD)')
    ap.add_argument('--until', help='ignore journal entries after this UTC date (YYYY-MM-DD)')
    ap.add_argument('--yes', action='store_true', help='skip the confirmation prompt')
    ap.add_argument('--snapshot', action='store_true',
                    help='reverse direction: back up DB history the journal is missing '
                         'into the local journal (for history predating journalling)')
    args = ap.parse_args()

    if args.snapshot:
        return snapshot(args)

    def parse_day(s):
        if not s:
            return None
        return int(datetime.strptime(s, '%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp())

    since, until = parse_day(args.since), parse_day(args.until)
    coins = [(s, i) for s, i in COINS if not args.coin or s in args.coin]
    if not coins:
        sys.exit(f"No matching coins. Known: {', '.join(s for s, _ in COINS)}")

    read_only = args.verify or args.dry_run
    supabase = get_supabase()
    plans = []

    print(f"\n{'VERIFY' if args.verify else 'DRY RUN' if args.dry_run else 'RESTORE'}"
          f"  ·  journal -> Supabase\n{'=' * 78}")

    for symbol, db_id in coins:
        journal, corrupt = read_journal(symbol, since, until)
        payload = fetch_payload(supabase, db_id)
        if payload is None:
            print(f"\n  {symbol}: no payload row (id={db_id}) — skipping")
            continue
        print(f"\n  {symbol}  (id={db_id})" + (f"   ⚠️ {corrupt} unreadable journal lines" if corrupt else ""))

        merged_payload, total_new = dict(payload), 0
        for series, key in SERIES.items():
            db_rows = payload.get(key) or []
            db_by_time = {r['time']: r for r in db_rows if isinstance(r.get('time'), int)}
            missing = summarize(key, journal[series], set(db_by_time))
            if not missing and not args.prefer_journal:
                continue
            merged = dict(db_by_time)
            for t, entry in journal[series].items():
                if t in merged and not args.prefer_journal:
                    continue
                merged[t] = entry
            new_rows = [merged[t] for t in sorted(merged)]
            if len(new_rows) != len(db_rows) or args.prefer_journal:
                merged_payload[key] = new_rows
                total_new += len(new_rows) - len(db_rows)
        if total_new:
            plans.append((symbol, db_id, merged_payload, total_new))
            print(f"      => would add {total_new} entries")
        else:
            print("      => ✅ DB already has everything in the journal")

    print(f"\n{'=' * 78}")
    if not plans:
        print("Nothing to restore — the journal and the DB agree.\n")
        return
    if read_only:
        print(f"{sum(p[3] for p in plans)} entries would be restored across "
              f"{len(plans)} coin(s). Re-run without --verify/--dry-run to write.\n")
        return

    print(f"About to write {len(plans)} payload(s), adding "
          f"{sum(p[3] for p in plans)} prediction entries.")
    if not args.yes:
        if input("Type 'yes' to push to Supabase: ").strip().lower() != 'yes':
            print("Aborted; nothing was written.\n")
            return
    for symbol, db_id, merged_payload, n in plans:
        try:
            supabase.table('predictions').upsert(
                {"id": db_id, "payload": merged_payload}, returning="minimal"
            ).execute()
            print(f"   ✅ {symbol}: restored (+{n} entries)")
        except Exception as e:
            print(f"   ❌ {symbol}: push failed: {e}")
    print()


if __name__ == '__main__':
    main()
