#!/usr/bin/env python3
"""Generate HTML email report for MKV conversion with TMDB posters."""

import sys
import os
import re
import json
import locale
import urllib.request
import urllib.parse
from datetime import datetime

TMDB_API_KEY = "08a78191b56b49e8c66ed4ff0beff5e8"
TMDB_IMG_BASE = "https://image.tmdb.org/t/p/w154"

# Config file path (passed as argv[2] or default)
CONFIG_FILE = sys.argv[2] if len(sys.argv) > 2 else os.environ.get(
    "CONFIG_FILE", "/app/config/config.json"
)


def parse_title_year(filename):
    """Extract title, year, media_type, season, episode from filename."""
    m = re.match(r'^(.+?)\s*\((\d{4})\)\s*-\s*S(\d+)E(\d+)', filename)
    if m:
        return m.group(1).strip(), m.group(2), "tv", int(m.group(3)), int(m.group(4))

    m = re.match(r'^(.+?)\s*-\s*S(\d+)E(\d+)', filename)
    if m:
        return m.group(1).strip(), None, "tv", int(m.group(2)), int(m.group(3))

    m = re.match(r'^(.+?)[\.\s]+[Ss](\d+)[Ee](\d+)', filename)
    if m:
        title = m.group(1).replace('.', ' ').strip()
        return title, None, "tv", int(m.group(2)), int(m.group(3))

    m = re.match(r'^(.+?)\s*\((\d{4})\)', filename)
    if m:
        return m.group(1).strip(), m.group(2), "movie", None, None

    return filename, None, "movie", None, None


def tmdb_request(path, params=None):
    """Make a TMDB API request."""
    params = params or {}
    params["api_key"] = TMDB_API_KEY
    url = f"https://api.themoviedb.org/3{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "MKV-Converter/1.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


_series_id_cache = {}

def fetch_tmdb(title, year, media_type, season=None, episode=None):
    """Fetch poster and info from TMDB."""
    try:
        if media_type == "movie":
            data = tmdb_request("/search/movie", {"query": title, **({"year": year} if year else {})})
            if data.get("results"):
                r = data["results"][0]
                poster = f"{TMDB_IMG_BASE}{r['poster_path']}" if r.get("poster_path") else None
                return {
                    "id": r.get("id"),
                    "title": r.get("title", title),
                    "year": r.get("release_date", "")[:4],
                    "rating": r.get("vote_average", 0),
                    "overview": r.get("overview", "")[:150],
                    "poster": poster,
                    "media_type": "movie",
                }
        else:
            cache_key = title.lower()
            if cache_key not in _series_id_cache:
                data = tmdb_request("/search/tv", {"query": title})
                if data.get("results"):
                    _series_id_cache[cache_key] = data["results"][0]

            series = _series_id_cache.get(cache_key)
            if not series:
                return {"title": title, "year": "", "rating": 0, "overview": "", "poster": None, "ep_label": ""}

            series_name = series.get("name", title)
            series_poster = f"{TMDB_IMG_BASE}{series['poster_path']}" if series.get("poster_path") else None

            if season is not None and episode is not None:
                try:
                    ep = tmdb_request(f"/tv/{series['id']}/season/{season}/episode/{episode}")
                    still = f"{TMDB_IMG_BASE}{ep['still_path']}" if ep.get("still_path") else None
                    return {
                        "id": series.get("id"),
                        "title": series_name,
                        "year": series.get("first_air_date", "")[:4],
                        "rating": ep.get("vote_average", 0),
                        "overview": ep.get("overview", "")[:150],
                        "poster": still or series_poster,
                        "ep_label": f"S{season:02d}E{episode:02d}",
                        "ep_name": ep.get("name", ""),
                        "media_type": "tv",
                    }
                except Exception:
                    pass

            return {
                "id": series.get("id"),
                "title": series_name,
                "year": series.get("first_air_date", "")[:4],
                "rating": series.get("vote_average", 0),
                "overview": series.get("overview", "")[:150],
                "poster": series_poster,
                "ep_label": f"S{season:02d}E{episode:02d}" if season and episode else "",
                "media_type": "tv",
            }
    except Exception:
        pass

    return {"title": title, "year": year or "", "rating": 0, "overview": "", "poster": None, "ep_label": ""}


def read_lines(filepath):
    """Read non-empty lines from file."""
    if not os.path.exists(filepath):
        return []
    with open(filepath) as f:
        return [l.strip() for l in f if l.strip()]


def generate_html(report_dir):
    converted = read_lines(os.path.join(report_dir, "converted.txt"))
    failed = read_lines(os.path.join(report_dir, "failed.txt"))
    dupes = read_lines(os.path.join(report_dir, "dupes.txt"))
    skipped = 0
    skip_file = os.path.join(report_dir, "skipped_empty.txt")
    if os.path.exists(skip_file):
        with open(skip_file) as f:
            skipped = int(f.read().strip() or 0)

    now = datetime.now()
    try:
        locale.setlocale(locale.LC_TIME, "en_US.UTF-8")
    except locale.Error:
        pass
    date_str = now.strftime("%A %d %B %Y")
    date_short = now.strftime("%d %B %Y")

    # Load server URL from config for download links
    try:
        _cfg_dl = json.load(open(CONFIG_FILE))
        server_url = _cfg_dl.get("serverUrl", "").rstrip("/")
    except Exception:
        server_url = ""

    tmdb_cache = {}
    converted_items = []
    for line in converted:
        parts = line.split("|")
        if len(parts) < 5:
            continue
        section, basename, old_size, new_size, duration = parts[:5]
        mp4_path = parts[5] if len(parts) > 5 else ""
        title, year, media_type, season, episode = parse_title_year(basename)

        if season is not None and episode is not None:
            cache_key = f"{title.lower()}_s{season}e{episode}"
        else:
            cache_key = title.lower()
        if cache_key not in tmdb_cache:
            tmdb_cache[cache_key] = fetch_tmdb(title, year, media_type, season, episode)

        info = tmdb_cache[cache_key]
        converted_items.append({
            "section": section, "basename": basename,
            "old_size": old_size, "new_size": new_size,
            "duration": duration, "mp4_path": mp4_path, "info": info,
        })

    failed_items = []
    for line in failed:
        parts = line.split("|")
        if len(parts) < 3:
            continue
        section, basename, size = parts[0], parts[1], parts[2]
        reason = parts[3].strip() if len(parts) > 3 else ""
        title, year, media_type, season, episode = parse_title_year(basename)

        if season is not None and episode is not None:
            cache_key = f"{title.lower()}_s{season}e{episode}"
        else:
            cache_key = title.lower()
        if cache_key not in tmdb_cache:
            tmdb_cache[cache_key] = fetch_tmdb(title, year, media_type, season, episode)

        info = tmdb_cache[cache_key]
        failed_items.append({"section": section, "basename": basename, "size": size, "reason": reason, "info": info})

    # Read config for From/To headers
    try:
        _cfg = json.load(open(CONFIG_FILE))
        _from = _cfg.get("smtp", {}).get("from", "noreply@autoconvert.local")
        _to = ", ".join(r["email"] for r in _cfg["recipients"] if r.get("active", True))
    except Exception:
        _from = "noreply@autoconvert.local"
        _to = ""

    html = []
    html.append(f"Content-Type: text/html; charset=utf-8")
    html.append(f"Subject: New Content for {date_short}")
    html.append(f"From: {_from}")
    html.append(f"To: {_to}")
    html.append(f"")
    html.append(f"""<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, Arial, sans-serif; color: #333; max-width: 750px; margin: 0 auto; padding: 20px; background: #fafafa;">

<div style="background: #fff; border-radius: 12px; padding: 30px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">

<h1 style="color: #1a73e8; margin: 0 0 5px 0; font-size: 24px;">New Content for {date_short}</h1>
<p style="color: #888; margin: 0 0 25px 0; font-size: 14px;">{date_str}</p>

<table style="border-collapse: collapse; width: 100%; margin-bottom: 30px; background: #f8f9fa; border-radius: 8px; overflow: hidden;">
<tr>
  <td style="padding: 15px 20px; text-align: center; border-right: 1px solid #e9ecef;">
    <div style="font-size: 28px; font-weight: bold; color: #2e7d32;">{len(converted_items)}</div>
    <div style="font-size: 12px; color: #666; text-transform: uppercase;">Converted</div>
  </td>
  <td style="padding: 15px 20px; text-align: center; border-right: 1px solid #e9ecef;">
    <div style="font-size: 28px; font-weight: bold; color: {'#c62828' if failed_items else '#2e7d32'};">{len(failed_items)}</div>
    <div style="font-size: 12px; color: #666; text-transform: uppercase;">Failed</div>
  </td>
  <td style="padding: 15px 20px; text-align: center; border-right: 1px solid #e9ecef;">
    <div style="font-size: 28px; font-weight: bold; color: #555;">{len(dupes)}</div>
    <div style="font-size: 12px; color: #666; text-transform: uppercase;">Duplicates</div>
  </td>
  <td style="padding: 15px 20px; text-align: center;">
    <div style="font-size: 28px; font-weight: bold; color: #999;">{skipped}</div>
    <div style="font-size: 12px; color: #666; text-transform: uppercase;">Skipped</div>
  </td>
</tr>
</table>""")

    if converted_items:
        html.append('<h2 style="color: #2e7d32; font-size: 18px; margin: 25px 0 15px 0;">Converted</h2>')

        seen_titles = set()
        for item in converted_items:
            info = item["info"]
            ep_label = info.get("ep_label", "")
            ep_name = info.get("ep_name", "")
            if ep_label:
                show_poster = True
            else:
                title_key = info["title"].lower()
                show_poster = title_key not in seen_titles
                seen_titles.add(title_key)

            poster_html = ""
            if show_poster and info["poster"]:
                poster_html = f'<img src="{info["poster"]}" style="width: 60px; border-radius: 6px; display: block;" alt="">'
            elif show_poster:
                poster_html = '<div style="width: 60px; height: 90px; background: #e9ecef; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #999;">No img</div>'

            rating_stars = ""
            if info["rating"] > 0:
                rating_val = round(info["rating"], 1)
                star_color = "#f5c518" if rating_val >= 7 else "#ff9800" if rating_val >= 5 else "#e53935"
                rating_stars = f'<span style="color: {star_color}; font-weight: bold; font-size: 13px;">★ {rating_val}</span>'

            section_badge = f'<span style="background: {"#e3f2fd" if item["section"] == "movies" else "#f3e5f5"}; color: {"#1565c0" if item["section"] == "movies" else "#7b1fa2"}; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;">{item["section"]}</span>'

            ep_badge = ""
            if ep_label:
                ep_badge = f'<span style="background: #e8f5e9; color: #2e7d32; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;">{ep_label}</span>'

            overview_html = ""
            if info["overview"]:
                overview_html = f'<div style="color: #888; font-size: 11px; margin-top: 4px; line-height: 1.4;">{info["overview"]}...</div>'

            size_saved = ""
            try:
                old_val = float(re.sub(r'[^0-9.]', '', item["old_size"]))
                new_val = float(re.sub(r'[^0-9.]', '', item["new_size"]))
                old_unit = re.sub(r'[0-9.]', '', item["old_size"])
                new_unit = re.sub(r'[0-9.]', '', item["new_size"])
                if old_unit == new_unit and old_val > 0:
                    pct = round((1 - new_val / old_val) * 100)
                    if pct > 0:
                        size_saved = f'<span style="color: #2e7d32; font-size: 11px;">(-{pct}%)</span>'
            except (ValueError, ZeroDivisionError):
                pass

            download_html = ""
            if server_url and item.get("mp4_path"):
                dl_url = f'{server_url}/api/download?path={urllib.parse.quote(item["mp4_path"])}'
                download_html = f'<a href="{dl_url}" style="display: inline-block; margin-top: 6px; background: #1a73e8; color: #fff; padding: 4px 12px; border-radius: 6px; font-size: 11px; font-weight: 600; text-decoration: none;">⬇ Download MP4</a>'

            html.append(f"""
<div style="display: flex; align-items: flex-start; padding: 12px 0; border-bottom: 1px solid #f0f0f0;">
  <div style="flex-shrink: 0; width: 65px; margin-right: 15px;">{poster_html}</div>
  <div style="flex-grow: 1; min-width: 0;">
    <div style="margin-bottom: 4px;">{section_badge} {ep_badge} {rating_stars}</div>
    <div style="font-weight: 600; font-size: 14px; color: #222;">{info["title"]}{f" ({info['year']})" if info["year"] else ""}{f" — {ep_name}" if ep_name else ""}</div>
    {overview_html}
    <div style="margin-top: 6px; font-size: 12px; color: #666;">
      <span style="background: #f5f5f5; padding: 2px 8px; border-radius: 4px;">{item["old_size"]} → {item["new_size"]}</span>
      {size_saved}
      <span style="margin-left: 8px; color: #999;">⏱ {item["duration"]}min</span>
    </div>
    {download_html}
  </div>
</div>""")

    if failed_items:
        html.append('<h2 style="color: #c62828; font-size: 18px; margin: 25px 0 15px 0;">Failed</h2>')
        for item in failed_items:
            info = item["info"]
            poster_html = ""
            if info["poster"]:
                poster_html = f'<img src="{info["poster"]}" style="width: 45px; border-radius: 4px;" alt="">'

            html.append(f"""
<div style="display: flex; align-items: center; padding: 10px; margin-bottom: 8px; background: #fef2f2; border-radius: 8px; border-left: 3px solid #c62828;">
  <div style="flex-shrink: 0; width: 50px; margin-right: 12px;">{poster_html}</div>
  <div>
    <div style="font-weight: 600; font-size: 13px; color: #c62828;">{info["title"]}{f" ({info['year']})" if info["year"] else ""}</div>
    <div style="font-size: 12px; color: #888;">{item["basename"]} ({item["size"]})</div>
  </div>
</div>""")

    if dupes:
        html.append('<h2 style="font-size: 18px; margin: 25px 0 15px 0; color: #555;">Removed Duplicates</h2>')
        html.append('<div style="background: #f8f9fa; border-radius: 8px; padding: 12px 16px;">')
        for line in dupes:
            parts = line.split("|")
            section = parts[0] if len(parts) > 1 else ""
            name = parts[1] if len(parts) > 1 else parts[0]
            html.append(f'<div style="padding: 4px 0; font-size: 13px; color: #666;">🗑 <strong>[{section}]</strong> {name}</div>')
        html.append('</div>')

    if not converted_items and not failed_items and not dupes:
        html.append("""
<div style="text-align: center; padding: 40px 0;">
  <div style="font-size: 48px; margin-bottom: 10px;">✅</div>
  <div style="font-size: 16px; color: #666;">No MKV files found. Everything is up-to-date!</div>
</div>""")

    html.append(f"""
<hr style="border: none; border-top: 1px solid #eee; margin: 25px 0 15px 0;">
<p style="color: #aaa; font-size: 11px; line-height: 1.6;">
  Automatically generated by AutoConvert<br>
  Preset: Niel (H.265 VideoToolbox 10-bit, CQ55)
</p>

</div>
</body></html>""")

    # Save JSON report with TMDB-enriched data (skip for resends)
    if not os.environ.get("RESEND"):
        save_json_report(report_dir, converted_items, failed_items, dupes, skipped)

    return "\n".join(html)


def save_json_report(report_dir, converted_items, failed_items, dupes, skipped):
    """Save/merge into today's JSON report file (one report per day)."""
    reports_dir = (
        sys.argv[3] if len(sys.argv) > 3
        else os.environ.get("REPORTS_DIR", "/app/logs/reports")
    )
    os.makedirs(reports_dir, exist_ok=True)

    start_time = os.environ.get("START_TIME", "")
    end_time = os.environ.get("END_TIME", "")
    now = datetime.now()

    if not start_time:
        start_time = now.isoformat(timespec="seconds")
    if not end_time:
        end_time = now.isoformat(timespec="seconds")

    date_str = now.strftime("%Y-%m-%d")

    converted_json = []
    for item in converted_items:
        info = item["info"]
        entry = {
            "section": item["section"],
            "basename": item["basename"],
            "old_size": item["old_size"],
            "new_size": item["new_size"],
            "duration": item["duration"],
            "tmdb": {
                "id": info.get("id"),
                "media_type": info.get("media_type", ""),
                "title": info.get("title", ""),
                "year": info.get("year", ""),
                "rating": info.get("rating", 0),
                "poster": info.get("poster", ""),
                "overview": info.get("overview", ""),
                "ep_label": info.get("ep_label", ""),
                "ep_name": info.get("ep_name", ""),
            },
        }
        if item.get("mp4_path"):
            entry["mp4_path"] = item["mp4_path"]
        converted_json.append(entry)

    failed_json = []
    for item in failed_items:
        info = item["info"]
        entry = {
            "section": item["section"],
            "basename": item["basename"],
            "size": item["size"],
            "tmdb": {
                "id": info.get("id"),
                "media_type": info.get("media_type", ""),
                "title": info.get("title", ""),
                "year": info.get("year", ""),
                "rating": info.get("rating", 0),
                "poster": info.get("poster", ""),
                "overview": info.get("overview", ""),
                "ep_label": info.get("ep_label", ""),
                "ep_name": info.get("ep_name", ""),
            },
        }
        if item.get("reason"):
            entry["reason"] = item["reason"]
        failed_json.append(entry)

    dupes_json = []
    for line in dupes:
        parts = line.split("|")
        section = parts[0] if len(parts) > 1 else ""
        name = parts[1] if len(parts) > 1 else parts[0]
        dupes_json.append({"section": section, "name": name})

    # Use date-based filename: one report per day
    filename = date_str + ".json"
    filepath = os.path.join(reports_dir, filename)

    # Merge into existing report if one exists for today
    existing = None
    if os.path.exists(filepath):
        try:
            with open(filepath) as f:
                existing = json.load(f)
        except Exception:
            existing = None

    if existing:
        # Append new results to existing report
        existing["converted"] = existing.get("converted", []) + converted_json
        existing["failed"] = existing.get("failed", []) + failed_json
        existing["dupes"] = existing.get("dupes", []) + dupes_json
        existing["skipped_empty"] = existing.get("skipped_empty", 0) + skipped
        existing["finished"] = end_time
        # Clear emailed flag so the daily email picks up new results
        existing.pop("emailed", None)
        report = existing
    else:
        report = {
            "date": date_str,
            "started": start_time,
            "finished": end_time,
            "converted": converted_json,
            "failed": failed_json,
            "dupes": dupes_json,
            "skipped_empty": skipped,
        }

    with open(filepath, "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    report_dir = sys.argv[1] if len(sys.argv) > 1 else "/tmp/mkv_convert_report"
    print(generate_html(report_dir))
