"""Verify the two actual browser recordings; never generate replacement frames."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

repo = Path(__file__).resolve().parents[4]
evidence = repo / 'docs/evidence/frontend'
checks = []
for number in (1, 2):
    file = evidence / 'video' / f'honeyforge-demo-{number}.webm'
    def run(args):
        return subprocess.run(args, capture_output=True, text=True)
    probe = run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height,avg_frame_rate', '-of', 'json', str(file)])
    decoded = run(['ffmpeg', '-v', 'error', '-i', str(file), '-f', 'null', '-'])
    black = run(['ffmpeg', '-hide_banner', '-i', str(file), '-vf', 'blackdetect=d=0.2:pix_th=0.10', '-an', '-f', 'null', '-'])
    motion = run(['ffmpeg', '-v', 'error', '-i', str(file), '-vf', 'fps=1', '-an', '-f', 'framemd5', '-'])
    frames = [line.split(',')[-1].strip() for line in motion.stdout.splitlines() if line and not line.startswith('#')]
    intervals = re.findall(r'black_start:[^\n]+', black.stderr)
    record = {
        'number': number, 'file': str(file), 'size_bytes': file.stat().st_size,
        'sha256': hashlib.sha256(file.read_bytes()).hexdigest(),
        'metadata': json.loads(probe.stdout),
        'decode_ok': decoded.returncode == 0 and not decoded.stderr.strip(),
        'decode_errors': decoded.stderr.strip(), 'black_intervals': intervals,
        'motion_sample_fps': 1, 'motion_sample_frames': len(frames),
        'motion_distinct_frames': len(set(frames)),
        'moving_content_verified': motion.returncode == 0 and len(set(frames)) >= 10,
    }
    record['passed'] = probe.returncode == 0 and record['decode_ok'] and not intervals and record['moving_content_verified']
    checks.append(record)
    print(json.dumps({k: record[k] for k in ['number', 'decode_ok', 'black_intervals', 'motion_sample_frames', 'motion_distinct_frames', 'passed']}))
(evidence / 'video-verification.json').write_text(json.dumps(checks, indent=2) + '\n')
if not all(c['passed'] for c in checks):
    raise SystemExit(1)
