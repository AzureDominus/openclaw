---
name: video-download
description: Download web videos with yt-dlp into the system temp directory, normalize them to compatibility-friendly H.264/AAC MP4 when needed, and clean them up after delivery. Use when a user wants a video from Instagram Reels, YouTube, Shorts, TikTok, or another yt-dlp-supported URL fetched, forwarded, archived, or inspected without leaving permanent media clutter on disk.
---

# Video Download

Use this skill when the goal is to fetch a web video safely, keep storage usage temporary, and hand the result to another tool or user.

## Quick workflow

1. Run `scripts/download_video.py download <video-url>`.
2. Read the JSON output and use the `file` path for the next step.
3. Deliver the file.
4. Run the `cleanup_command` from the JSON output, or call the script's `cleanup` subcommand directly.

## Commands

### Download to a fresh temp dir

```bash
python3 /home/timmy/repos/openclaw/skills/video-download/scripts/download_video.py download "https://example.com/video"
```

By default, the script downloads into the system temp directory returned by Python's `tempfile.gettempdir()` so files stay temporary and easy to clean up.

Optional temp root override:

```bash
python3 /home/timmy/repos/openclaw/skills/video-download/scripts/download_video.py download "https://example.com/video" --tmp-root /tmp
```

The script prints JSON like:

```json
{
  "ok": true,
  "tmpdir": "/tmp/video-download-abc123",
  "file": "/tmp/video-download-abc123/uploader-abc123.mp4",
  "title": "Video title",
  "cleanup_command": "/home/timmy/repos/openclaw/skills/video-download/scripts/download_video.py cleanup /tmp/video-download-abc123"
}
```

### Cleanup

```bash
python3 /home/timmy/repos/openclaw/skills/video-download/scripts/download_video.py cleanup /tmp/video-download-abc123
```

You can also pass the downloaded file path. The script will remove its temp directory.

## Delivery notes

- Prefer sending or processing the file immediately after download.
- Prefer the script default temp root first. It uses the system temp directory from Python, so media stays ephemeral.
- If a tool rejects the temp path, add the relevant temp root in config with `messages.mediaLocalRoots`, or relay through another allowed path and delete both copies right after delivery.
- Do not leave downloads sitting in the workspace or home directory.

## Behavior and limits

- Best for public or otherwise accessible URLs that yt-dlp supports.
- Private, login-gated, deleted, geo-restricted, DRM-protected, or rate-limited videos can fail.
- The script prefers `uvx --from yt-dlp yt-dlp` so the downloader can run ephemerally without a permanent install.
- The default temp location is the system temp directory from `tempfile.gettempdir()`.
- The script normalizes non-H.264 outputs to H.264/AAC MP4 for better playback compatibility in chat apps.
- If `uvx` is unavailable, the script falls back to `yt-dlp` if already installed.

## Files

### scripts/download_video.py

Python helper that:

- validates the URL shape
- creates a fresh temp dir with the `video-download-` prefix
- fetches metadata with yt-dlp
- downloads and merges the best available audio/video stream when needed
- normalizes non-H.264 outputs to compatibility-friendly H.264/AAC MP4 when needed
- prints JSON output for downstream automation
- deletes its temp dir automatically on failure
- supports a safe `cleanup` subcommand for temp-dir removal
