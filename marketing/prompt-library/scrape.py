#!/usr/bin/env python3
"""Scrape VeoSee prompt library (machinelearningall) back to a date cutoff."""
import json, os, re, ssl, sys, time, urllib.request
from bs4 import BeautifulSoup

CHANNEL = "machinelearningall"
CUTOFF = "2026-01-01"
OUT = os.path.join(os.path.dirname(__file__), "prompts_2026.json")
CA = "/root/.ccr/ca-bundle.crt"
MAX_PAGES = 400

ctx = ssl.create_default_context(cafile=CA)
proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
handlers = [urllib.request.HTTPSHandler(context=ctx)]
if proxy:
    handlers.append(urllib.request.ProxyHandler({"https": proxy, "http": proxy}))
opener = urllib.request.build_opener(*handlers)
opener.addheaders = [("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")]

def fetch(before=None):
    url = f"https://t.me/s/{CHANNEL}"
    if before:
        url += f"?before={before}"
    for attempt in range(5):
        try:
            with opener.open(url, timeout=30) as r:
                return r.read().decode("utf-8")
        except Exception as e:
            print(f"  retry {attempt+1} before={before}: {e}", file=sys.stderr)
            time.sleep(2 ** (attempt + 1))
    return ""

def parse(html):
    soup = BeautifulSoup(html, "lxml")
    out = []
    for m in soup.select("div.tgme_widget_message"):
        dp = m.get("data-post", "")
        mm = re.search(r"/(\d+)$", dp)
        if not mm:
            continue
        pid = int(mm.group(1))
        t = m.select_one("time[datetime]")
        date = t["datetime"] if t else None
        body = m.select_one(".tgme_widget_message_text")
        text = ""
        if body:
            for br in body.find_all("br"):
                br.replace_with("\n")
            text = body.get_text("\n", strip=False).strip()
        out.append({"id": pid, "date": date, "text": text})
    return out

allp, before, pages = {}, None, 0
while pages < MAX_PAGES:
    html = fetch(before)
    if not html:
        break
    posts = parse(html)
    if not posts:
        break
    new = [p for p in posts if p["id"] not in allp]
    for p in posts:
        allp[p["id"]] = p
    mn = min(p["id"] for p in posts)
    mnd = min((p["date"] or "9") for p in posts)
    pages += 1
    if pages % 10 == 0 or mnd < CUTOFF:
        print(f"page {pages}: ids {mn}.. oldest {mnd[:10]}, total {len(allp)}")
    if mnd < CUTOFF or mn <= 1 or not new:
        break
    before = mn
    time.sleep(0.5)

res = [p for p in sorted(allp.values(), key=lambda p: p["id"]) if (p["date"] or "") >= CUTOFF]
json.dump(res, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"saved {len(res)} posts since {CUTOFF} to {OUT}")
