#!/usr/bin/env python3
import argparse, json, os
from pathlib import Path

PLACES_MARKER = "'__CAIRODRIVE_EMBEDDED_GOOGLE_PLACES_KEY__'"
ROUTES_MARKER = "'__CAIRODRIVE_EMBEDDED_GOOGLE_ROUTES_KEY__'"


def parse_config(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for raw in path.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        out[key.strip()] = value.strip().strip('"').strip("'")
    return out


def unusable(value: str) -> bool:
    return not value or value in {'REPLACE_ME', 'REPLACE_WITH_YOUR_KEY', 'YOUR_KEY'} or value.startswith('REPLACE_')


def main() -> int:
    ap = argparse.ArgumentParser(description='Inject private-repo Google keys into a temporary CairoDrive agent source.')
    ap.add_argument('agent')
    ap.add_argument('config')
    ns = ap.parse_args()
    agent = Path(ns.agent)
    config = Path(ns.config)
    values = parse_config(config)
    places = (os.getenv('GOOGLE_PLACES_API_KEY') or values.get('GOOGLE_PLACES_API_KEY') or '').strip()
    routes = (os.getenv('GOOGLE_ROUTES_API_KEY') or values.get('GOOGLE_ROUTES_API_KEY') or places).strip()
    if unusable(places):
        raise SystemExit('ERROR: Google Places key is not configured. Run ./PUSH_TO_GITHUB.sh once to write config/google_keys.env.')
    if unusable(routes):
        routes = places
    text = agent.read_text(encoding='utf-8')
    if PLACES_MARKER not in text or ROUTES_MARKER not in text:
        raise SystemExit('ERROR: embedded Google key source markers are missing')
    text = text.replace(PLACES_MARKER, json.dumps(places))
    text = text.replace(ROUTES_MARKER, json.dumps(routes))
    if '__CAIRODRIVE_EMBEDDED_GOOGLE_' in text:
        raise SystemExit('ERROR: Google key injection marker survived')
    agent.write_text(text, encoding='utf-8')
    print('Embedded Google keys: Places=yes Routes=' + ('shared' if routes == places else 'separate'))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
