#!/usr/bin/env python3
"""
@fileoverview Find duplicated JS/TS functions in the repository.

Produces JSON with groups: exact_body_duplicates, identical_named_duplicates, fuzzy_duplicates.

This is a lightweight, heuristic scanner (regex-based) — it will catch most top-level and
assigned functions but may miss or mis-parse complex patterns. It's designed to be safe
and fast without external dependencies and intended for developer review rather than
automated refactoring.

Author: ComputerGenieCo
Version: 1.2.0
Copyright: 2025

Usage:
    # Run and write the report to the repository tools folder (recommended):
    python3 tools/find_js_duplicates.py > tools/duplicates_report.json

    # Run and view JSON on stdout (no file written):
    python3 tools/find_js_duplicates.py

Notes:
    - The script prints a JSON object to stdout; redirect it to a file when you want to
        store or review the results persistently.
    - The produced JSON contains three top-level arrays: exact_body_duplicates,
        identical_named_duplicates, and fuzzy_duplicates. Each entry contains file paths
        and line ranges to help with manual review.
"""
import os
import re
import json
import sys
from collections import defaultdict
from difflib import SequenceMatcher

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

EXTS = ('.js', '.jsx', '.ts', '.tsx')
EXCLUDE_DIRS = ('node_modules', 'dist', 'build', '.git', 'website/static/scripts')


def list_files(root):
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        # filter out excluded dirs
        # Support EXCLUDE_DIRS entries that are multi-level relative paths
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir == '.':
            rel_dir = ''

        def keep_dir(d):
            # child relative path from root, normalize for comparison
            child_rel = os.path.normpath(os.path.join(rel_dir, d)) if rel_dir else d
            for ex in EXCLUDE_DIRS:
                ex_norm = os.path.normpath(ex)
                # exact match or prefix match (exclude nested paths)
                if child_rel == ex_norm or child_rel.startswith(ex_norm + os.sep):
                    return False
            return True

        dirnames[:] = [d for d in dirnames if keep_dir(d)]
        for fn in filenames:
            if fn.endswith(EXTS):
                files.append(os.path.join(dirpath, fn))
    return files


def read_file(path):
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    except Exception:
        return ''


def strip_comments(code):
    # remove /* */ and // comments (simple)
    code = re.sub(r"/\*.*?\*/", '', code, flags=re.S)
    code = re.sub(r"//.*?$", '', code, flags=re.M)
    return code


def normalize(code):
    s = strip_comments(code)
    s = re.sub(r"\s+", ' ', s)
    s = s.strip()
    return s


FUNC_PATTERNS = [
    # function declarations: function name(...){
    re.compile(r"^\s*function\s+([A-Za-z0-9_$]+)\s*\([^\)]*\)\s*\{", re.M),
    # var/let/const name = function(...){
    re.compile(r"^\s*(?:var|let|const)\s+([A-Za-z0-9_$]+)\s*=\s*function\b", re.M),
    # var/let/const name = (...) => { or = arg => {
    re.compile(r"^\s*(?:var|let|const)\s+([A-Za-z0-9_$]+)\s*=\s*[^=\n]*=>\s*\{", re.M),
    # class or object method shorthand: name(...) {  (we will match any leading identifier at line start)
    re.compile(r"^\s*([A-Za-z0-9_$]+)\s*\([^\)]*\)\s*\{", re.M),
]

# Names that look like control keywords or trivial global calls —
# if these are matched as method-shorthand they are almost certainly
# false positives for our purpose. Keep this list small and obvious.
KEYWORD_NAMES = {
    'if', 'for', 'while', 'switch', 'catch', 'else',
    'constructor', 'settimeout', 'setinterval', 'timeout'
}


def extract_functions(code, path):
    lines = code.splitlines()
    results = []
    # We'll iterate line by line and attempt to detect function starts
    i = 0
    L = len(lines)
    while i < L:
        line = lines[i]
        matched = None
        name = None
        for pat in FUNC_PATTERNS:
            m = pat.match(line)
            if m:
                matched = m
                name = m.group(1) if m.groups() else None
                # Skip trivial control-like matches early (blacklist)
                if name and name.strip().lower() in KEYWORD_NAMES:
                    i += 1
                    matched = None
                    name = None
                    break
                break
        if not matched:
            i += 1
            continue

        # collect from this line onward until braces balanced
        start = i
        brace_count = 0
        found_brace = False
        j = i
        while j < L:
            l = lines[j]
            # count braces
            brace_count += l.count('{')
            brace_count -= l.count('}')
            if '{' in l:
                found_brace = True
            j += 1
            if found_brace and brace_count <= 0:
                break
        end = j
        func_code = '\n'.join(lines[start:end])
        snippet = func_code[:120].replace('\n', '\\n')
        results.append({
            'path': os.path.relpath(path, ROOT),
            'start_line': start + 1,
            'end_line': end,
            'name': name,
            'code': func_code,
            'norm': normalize(func_code),
            'snippet': snippet,
        })
        i = end
    return results


def group_exact(funcs):
    by_body = defaultdict(list)
    for f in funcs:
        key = f['norm']
        by_body[key].append(f)
    groups = []
    for k, items in by_body.items():
        if len(items) > 1 and k:
            groups.append(items)
    return groups


def group_identical_named(funcs):
    by_name = defaultdict(list)
    for f in funcs:
        if f['name']:
            by_name[f['name']].append(f)
    groups = []
    for name, items in by_name.items():
        # only if there are multiple and at least two different bodies
        bodies = set(i['norm'] for i in items)
        if len(items) > 1 and len(bodies) > 1:
            groups.append(items)
    return groups


def group_fuzzy(funcs, threshold=0.8):
    # single-linkage clustering: pick a representative and cluster similar ones
    unused = list(funcs)
    groups = []
    while unused:
        rep = unused.pop(0)
        cluster = [rep]
        to_remove = []
        for other in unused:
            if not rep['norm'] or not other['norm']:
                continue
            score = SequenceMatcher(None, rep['norm'], other['norm']).ratio()
            if score >= threshold and score < 1.0:
                cluster.append({**other, 'similarity': score})
                to_remove.append(other)
        for r in to_remove:
            unused.remove(r)
        if len(cluster) > 1:
            groups.append(cluster)
    return groups


def make_entry(f):
    return {
        'path': f['path'],
        'start_line': f['start_line'],
        'end_line': f['end_line'],
        'name': f['name'],
        'snippet': (f['snippet'][:120] if f.get('snippet') else ''),
    }


def choose_canonical(group):
    # choose the file with the shortest relative path (heuristic)
    sorted_items = sorted(group, key=lambda x: (len(x['path']), x['path']))
    canon = sorted_items[0]
    justification = f"first by path ({canon['path']}) and shortest path heuristic"
    return os.path.relpath(os.path.join(ROOT, canon['path']), ROOT), justification


def main():
    files = list_files(ROOT)
    funcs = []
    for path in files:
        code = read_file(path)
        if not code:
            continue
        funcs.extend(extract_functions(code, path))

    exact_groups = group_exact(funcs)
    ident_groups = group_identical_named(funcs)
    # For fuzzy, exclude those already exact duplicates to avoid duplication
    exact_norms = set(g[0]['norm'] for g in exact_groups if g and g[0]['norm'])
    remaining = [f for f in funcs if f['norm'] not in exact_norms]
    fuzzy_groups = group_fuzzy(remaining, threshold=0.82)

    out = {
        'exact_body_duplicates': [],
        'identical_named_duplicates': [],
        'fuzzy_duplicates': [],
    }

    for g in exact_groups:
        entries = [make_entry(f) for f in g]
        canon, just = choose_canonical(g)
        out['exact_body_duplicates'].append({
            'functions': entries,
            'suggested_canonical': canon,
            'justification': just,
        })

    for g in ident_groups:
        entries = [make_entry(f) for f in g]
        canon, just = choose_canonical(g)
        out['identical_named_duplicates'].append({
            'functions': entries,
            'suggested_canonical': canon,
            'justification': just,
        })

    for g in fuzzy_groups:
        # rep is first
        rep = g[0]
        rep_entry = make_entry(rep)
        others = []
        for o in g[1:]:
            others.append({
                **make_entry(o),
                'similarity': round(o.get('similarity', 0.0), 3),
            })
        canon, just = choose_canonical(g)
        out['fuzzy_duplicates'].append({
            'representative': rep_entry,
            'matches': others,
            'suggested_canonical': canon,
            'justification': just,
        })

    print(json.dumps(out, indent=2))


if __name__ == '__main__':
    main()
