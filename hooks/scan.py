"""Totals Claude Code token usage per session and per model from the local transcripts.

usage: scan.py <projects_dir> <week_start_ms> <five_hour_start_ms>
Prints one JSON object. "tokens" = input + cache writes + output; cache reads are kept apart.
"""
import json
import os
import re
import sys
from datetime import datetime


def ms(stamp):
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000


def files(root, since_ms):
    # <project>/<session>.jsonl, and <project>/<session>/subagents/*.jsonl counted to that session
    for project in os.listdir(root):
        pdir = os.path.join(root, project)
        if not os.path.isdir(pdir):
            continue
        for name in os.listdir(pdir):
            path = os.path.join(pdir, name)
            if name.endswith(".jsonl"):
                yield project, name[:-6], path, False
            elif os.path.isdir(os.path.join(path, "subagents")):
                sub = os.path.join(path, "subagents")
                for agent in os.listdir(sub):
                    if agent.endswith(".jsonl"):
                        yield project, name, os.path.join(sub, agent), True


def scan(root, week_ms, five_ms):
    seen = set()
    sessions = {}
    models = {}
    for project, sid, path, is_sub in files(root, week_ms):
        try:
            if os.path.getmtime(path) * 1000 < week_ms:
                continue
            fh = open(path, encoding="utf-8", errors="replace")
        except OSError:
            continue
        s = sessions.setdefault(sid, {"id": sid, "project": project, "title": "", "prompt": "",
                                      "tokens": 0, "cacheRead": 0, "fiveTokens": 0, "lastMs": 0, "models": {}})
        with fh:
            for line in fh:
                if not is_sub and '"custom-title"' in line:
                    s["title"] = json.loads(line).get("customTitle") or s["title"]
                    continue
                if not is_sub and '"last-prompt"' in line and not s["prompt"]:
                    s["prompt"] = json.loads(line).get("lastPrompt") or ""
                    continue
                if '"usage"' not in line or '"assistant"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                m = d.get("message") or {}
                u = m.get("usage")
                model = m.get("model")
                if d.get("type") != "assistant" or not u or not model or model.startswith("<"):
                    continue
                key = (m.get("id"), d.get("requestId"))
                if key in seen:  # one API reply is written once per content block
                    continue
                seen.add(key)
                at = ms(d["timestamp"])
                if at < week_ms:
                    continue
                tok = u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("output_tokens", 0)
                read = u.get("cache_read_input_tokens", 0)
                five = tok if at >= five_ms else 0
                s["tokens"] += tok
                s["cacheRead"] += read
                s["fiveTokens"] += five
                s["lastMs"] = max(s["lastMs"], at)
                s["models"][model] = s["models"].get(model, 0) + tok
                mm = models.setdefault(model, {"model": model, "tokens": 0, "cacheRead": 0, "fiveTokens": 0})
                mm["tokens"] += tok
                mm["cacheRead"] += read
                mm["fiveTokens"] += five
    used = [s for s in sessions.values() if s["tokens"] or s["cacheRead"]]
    home = re.sub(r"[^a-zA-Z0-9]", "-", os.path.expanduser("~"))  # how Claude Code names project folders
    for s in used:
        p = s["project"]
        s["project"] = (p[len(home):].lstrip("-") or "~") if p.startswith(home) else p
        s["title"] = (s["title"] or s["prompt"] or s["id"][:8]).strip().replace("\n", " ")[:80]
        del s["prompt"]
    used.sort(key=lambda s: -s["tokens"])
    ms_list = sorted(models.values(), key=lambda m: -m["tokens"])
    return {
        "sessions": used,
        "models": ms_list,
        "tokens": sum(s["tokens"] for s in used),
        "cacheRead": sum(s["cacheRead"] for s in used),
        "fiveTokens": sum(s["fiveTokens"] for s in used),
    }


if __name__ == "__main__":
    print(json.dumps(scan(sys.argv[1], float(sys.argv[2]), float(sys.argv[3]))))
