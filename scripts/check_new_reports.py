"""Look for new expenditure and payroll reports; download the Assembly's, flag the Senate's.

Assembly: its semi-annual Expenditure Report is a plain CSV at a predictable address,
    https://nyassembly.gov/write/upload/expenditure/YYYYMMDD.csv (YYYYMMDD = period end, Mar 31 or Sep 30).
    When the next one is published it is saved to data/raw/assembly/assembly-YYYYMMDD.csv, and only the
    newest KEEP reports stay in the report-period selector (older ones move to data/raw/assembly/history/,
    where the spending-over-the-years charts still read them).
Senate: nysenate.gov runs a bot check, so nothing here contacts it. Instead this works out from the data
    on file whether a newer biweekly payroll report or semi-annual expenditure report should be out by now,
    and writes a notice the workflow turns into a GitHub issue, so someone can download it by hand.

Writes to $GITHUB_OUTPUT (when set): assembly_new=true|false, senate_due=true|false, and the notice
text to data/raw/.senate_due.md (not committed).
"""
import os, pathlib, re, shutil, sys, urllib.request
from datetime import date, timedelta
import json

ROOT = pathlib.Path(__file__).resolve().parent.parent
UA = "NY-Legislature-Expenditures data refresh (+https://github.com/rike4545/NY-Legislature-Expenditures)"
KEEP = 4  # Assembly reports kept in the selector


def ends_on_file(folder, pattern):
    out = []
    for f in folder.glob("*.csv"):
        m = re.search(pattern, f.name)
        if m:
            out.append((date(int(m.group(1)[:4]), int(m.group(1)[4:6]), int(m.group(1)[6:])), f))
    return sorted(out)


def next_end(d):
    return date(d.year, 9, 30) if d.month == 3 else date(d.year + 1, 3, 31)


def assembly():
    raw = ROOT / "data/raw/assembly"
    have = ends_on_file(raw, r"(\d{8})\.csv$") + ends_on_file(raw / "history", r"(\d{8})\.csv$")
    latest = max(d for d, _ in have)
    target = next_end(latest)
    if date.today() < target + timedelta(days=30):
        print(f"Assembly: latest report ends {latest}; the next (ending {target}) isn't due yet")
        return False
    url = f"https://nyassembly.gov/write/upload/expenditure/{target:%Y%m%d}.csv"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=120) as r:
            body = r.read()
    except Exception as e:  # noqa: BLE001 - a 404 just means it isn't published yet
        print(f"Assembly: report ending {target} not published yet ({e})")
        return False
    if not body.lstrip().upper().startswith(b"UNIT") or len(body) < 100_000:
        print(f"Assembly: {url} didn't look like an expenditure report; skipped")
        return False
    out = raw / f"assembly-{target:%Y%m%d}.csv"
    out.write_bytes(body)
    print(f"Assembly: saved new report ending {target} ({len(body):,} bytes)")
    current = ends_on_file(raw, r"(\d{8})\.csv$")
    (raw / "history").mkdir(exist_ok=True)
    for d, f in current[:-KEEP]:
        dest = raw / "history" / f"{d:%Y%m%d}.csv"
        if dest.exists():
            f.unlink()
        else:
            shutil.move(str(f), dest)
        print(f"  moved report ending {d} to history")
    return True


def senate():
    notes = []
    pr = json.loads((ROOT / "data/senate/payroll.json").read_text())
    last_pay = date.fromisoformat(pr["reports"][-1][0])
    if date.today() - last_pay > timedelta(days=24):
        notes.append(f"- **Biweekly payroll:** the newest report on file is for the period ending {last_pay:%B %-d, %Y}. "
                     f"Reports come every two weeks, so one or more newer ones should be on "
                     f"[nysenate.gov/open-data](https://www.nysenate.gov/open-data) (\"Payroll Report - End Date …\"). "
                     f"Download each CSV and add it to `data/raw/senate/payroll/senate_payroll_reports.csv.gz`, then run `scripts/build_payroll.py`.")
    have = ends_on_file(ROOT / "data/raw/senate", r"nysenate_expenditures_(\d{8})\.csv$")
    latest = max(d for d, _ in have)
    target = next_end(latest)
    if date.today() > target + timedelta(days=75):
        notes.append(f"- **Expenditure report:** the newest on file ends {latest:%B %-d, %Y}; the report for "
                     f"{latest + timedelta(days=1):%B %-d, %Y} – {target:%B %-d, %Y} may be out. "
                     f"Save it (and the member travel file) as `data/raw/senate/nysenate_expenditures_{target:%Y%m%d}.csv` "
                     f"and `nysenate_member_travel_{target:%Y%m%d}.csv`.")
    if notes:
        text = ("The weekly refresh doesn't download from nysenate.gov (the site runs a bot check), "
                "so these need to be fetched by hand:\n\n" + "\n".join(notes) +
                "\n\nPushing the new files to `main` rebuilds and redeploys the site.\n")
        (ROOT / "data/raw/.senate_due.md").write_text(text)
        print(text)
    else:
        print("Senate: data on file looks current")
    return bool(notes)


def main():
    a = assembly()
    s = senate()
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"assembly_new={'true' if a else 'false'}\nsenate_due={'true' if s else 'false'}\n")


if __name__ == "__main__":
    sys.exit(main())
