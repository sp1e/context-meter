"""Reads the tail of every recently written session transcript and prints,
as JSON, the context fill of its last main-thread model response.

Usage: python scan.py <projects dir> <max age in seconds>
"""
import json
import os
import sys
import time

CHUNKS = (512 * 1024, 4 * 1024 * 1024)


def last_lines(path, size, chunk):
    with open(path, 'rb') as f:
        start = max(0, size - chunk)
        f.seek(start)
        data = f.read()
    lines = data.split(b'\n')
    # The first line of a cut read is a partial record.
    return lines[1:] if start > 0 else lines


def read_tail(path, size):
    for chunk in CHUNKS:
        usage = title = None
        for raw in reversed(last_lines(path, size, chunk)):
            if not raw.strip():
                continue
            try:
                row = json.loads(raw)
            except ValueError:
                continue
            kind = row.get('type')
            if title is None and kind == 'custom-title':
                title = row.get('customTitle')
            if usage is None and kind == 'assistant' and not row.get('isSidechain'):
                message = row.get('message') or {}
                if message.get('usage') and message.get('model') != '<synthetic>':
                    usage = (row, message)
            if usage and title:
                break
        if usage:
            row, message = usage
            u = message['usage']
            tokens = (u.get('input_tokens', 0) + u.get('cache_read_input_tokens', 0)
                      + u.get('cache_creation_input_tokens', 0))
            return {
                'label': title or '',
                'cwd': row.get('cwd', ''),
                'model': message.get('model', ''),
                'tokens': tokens,
            }
        if size <= chunk:
            return None
    return None


def main():
    root, max_age = sys.argv[1], float(sys.argv[2])
    now = time.time()
    found = []
    for project in os.scandir(root):
        if not project.is_dir():
            continue
        for entry in os.scandir(project.path):
            if not entry.name.endswith('.jsonl') or not entry.is_file():
                continue
            stat = entry.stat()
            if now - stat.st_mtime > max_age:
                continue
            info = read_tail(entry.path, stat.st_size)
            if info:
                info['id'] = entry.name[:-len('.jsonl')]
                info['updatedAt'] = int(stat.st_mtime * 1000)
                found.append(info)
    print(json.dumps(found))


if __name__ == '__main__':
    main()
