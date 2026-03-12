#!/usr/bin/env python3
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

PREFIX = "video-download-"


def preferred_tmp_root() -> Path | None:
    candidate = Path(tempfile.gettempdir())
    try:
        candidate.mkdir(parents=True, exist_ok=True, mode=0o700)
        return candidate.resolve()
    except Exception:
        return None


def fail(message: str, code: int = 1) -> None:
    print(json.dumps({"ok": False, "error": message}), file=sys.stderr)
    raise SystemExit(code)


def ensure_web_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        fail("URL must start with http:// or https://")
    if not (parsed.netloc or "").strip():
        fail("URL must include a hostname")


def run(cmd: list[str], capture: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        text=True,
        capture_output=capture,
        check=False,
    )


def ytdlp_base_cmd() -> list[str]:
    uvx = shutil.which("uvx")
    if uvx:
        return [uvx, "--from", "yt-dlp", "yt-dlp"]
    ytdlp = shutil.which("yt-dlp")
    if ytdlp:
        return [ytdlp]
    fail("Neither uvx nor yt-dlp is available. Install uv or yt-dlp, or ask for permission to install one.")


def fetch_metadata(url: str) -> dict:
    cmd = ytdlp_base_cmd() + [
        "--no-playlist",
        "--simulate",
        "--dump-single-json",
        url,
    ]
    proc = run(cmd)
    if proc.returncode != 0:
        stderr = (proc.stderr or proc.stdout or "").strip()
        fail(f"Metadata fetch failed: {stderr}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        fail(f"Could not parse yt-dlp metadata JSON: {exc}")


def find_downloaded_file(tmpdir: Path) -> Path:
    files = [p for p in tmpdir.iterdir() if p.is_file()]
    if not files:
        fail(f"No files found in temp directory {tmpdir}")
    files.sort(key=lambda p: p.stat().st_size, reverse=True)
    return files[0]


def probe_media(file_path: Path) -> dict:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name,codec_type",
        "-of",
        "json",
        str(file_path),
    ]
    proc = run(cmd)
    if proc.returncode != 0:
        stderr = (proc.stderr or proc.stdout or "").strip()
        fail(f"ffprobe failed: {stderr}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        fail(f"Could not parse ffprobe JSON: {exc}")


def normalize_for_compatibility(file_path: Path) -> Path:
    probe = probe_media(file_path)
    streams = probe.get("streams", [])
    video_codec = next((s.get("codec_name") for s in streams if s.get("codec_type") == "video"), None)
    audio_codec = next((s.get("codec_name") for s in streams if s.get("codec_type") == "audio"), None)
    if video_codec == "h264" and (audio_codec in {None, "aac"}):
        return file_path

    compat_path = file_path.with_name(f"{file_path.stem}-compat.mp4")
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(file_path),
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        str(compat_path),
    ]
    proc = run(cmd)
    if proc.returncode != 0:
        stderr = (proc.stderr or proc.stdout or "").strip()
        fail(f"ffmpeg transcode failed: {stderr}")
    compat_path.replace(file_path)
    return file_path


def download(url: str, tmp_root: str | None) -> int:
    ensure_web_url(url)

    base_dir = Path(tmp_root).expanduser().resolve() if tmp_root else preferred_tmp_root()
    if base_dir:
        base_dir.mkdir(parents=True, exist_ok=True)
        tmpdir = Path(tempfile.mkdtemp(prefix=PREFIX, dir=str(base_dir)))
    else:
        tmpdir = Path(tempfile.mkdtemp(prefix=PREFIX))

    try:
        metadata = fetch_metadata(url)
        output_template = str(tmpdir / "%(uploader_id|channel|extractor)s-%(id)s.%(ext)s")
        cmd = ytdlp_base_cmd() + [
            "--no-playlist",
            "-f",
            "bv*+ba/b",
            "--merge-output-format",
            "mp4",
            "-o",
            output_template,
            url,
        ]
        proc = run(cmd)
        if proc.returncode != 0:
            stderr = (proc.stderr or proc.stdout or "").strip()
            fail(f"Download failed: {stderr}")

        file_path = normalize_for_compatibility(find_downloaded_file(tmpdir))
        result = {
            "ok": True,
            "url": url,
            "tmpdir": str(tmpdir),
            "file": str(file_path),
            "filename": file_path.name,
            "size_bytes": file_path.stat().st_size,
            "id": metadata.get("id"),
            "title": metadata.get("title"),
            "uploader": metadata.get("uploader") or metadata.get("channel") or metadata.get("uploader_id") or metadata.get("extractor"),
            "ext": file_path.suffix.lstrip("."),
            "cleanup_command": f'{Path(__file__).resolve()} cleanup {tmpdir}',
        }
        print(json.dumps(result, indent=2))
        return 0
    except SystemExit:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(tmpdir, ignore_errors=True)
        fail(str(exc))
    return 1


def cleanup(path_value: str) -> int:
    path = Path(path_value).expanduser().resolve()
    target = path.parent if path.is_file() else path
    if not target.exists():
        print(json.dumps({"ok": True, "removed": [], "skipped": [str(target)], "reason": "path_missing"}, indent=2))
        return 0
    if not target.name.startswith(PREFIX):
        fail(f"Refusing to remove non-temp path: {target}")
    shutil.rmtree(target)
    print(json.dumps({"ok": True, "removed": [str(target)]}, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Download a web video into a temp directory, normalize to compatibility-friendly MP4, and print JSON metadata.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    download_parser = subparsers.add_parser("download", help="Download a supported web video to a fresh temp dir")
    download_parser.add_argument("url", help="Video URL supported by yt-dlp")
    download_parser.add_argument("--tmp-root", help="Optional base directory for temp dirs")

    cleanup_parser = subparsers.add_parser("cleanup", help="Delete a temp dir created by this script")
    cleanup_parser.add_argument("path", help="Temp directory path or file path inside it")

    args = parser.parse_args()
    if args.command == "download":
        return download(args.url, args.tmp_root)
    if args.command == "cleanup":
        return cleanup(args.path)
    fail("Unknown command")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
