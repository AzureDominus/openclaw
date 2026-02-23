---
name: av-media
description: Work with local audio/video media using `gemav` for transcription and media analysis. Use when a user asks to transcribe audio, describe video content, extract spoken action items, or run custom prompts against audio/video files (mp3, wav, ogg, m4a, mp4, mov, webm). In this skill, “multimodal” means audio/video only and explicitly excludes images. Do NOT use for plain text/article/web summarization, document reading, or image tasks.
---

# AV Media (gemav)

Use `gemav` for **audio/video** prompts only.

## Scope (strict)

Use this skill for:

- Audio transcription
- Video description + transcript
- Audio/video custom prompt analysis
- Extracting spoken decisions/tasks from media

Do NOT use this skill for:

- Summarizing text files, docs, chats, or web pages
- Tasks where the content is already readable as text
- Image-only analysis

For non-media summarization/read tasks, use native read/tooling or subagents.
For images, use native image reading/vision tooling.

## Core rules

- Require local media file path (`audio/*` or `video/*`).
- Preserve manual prompt support by passing user prompt through `--prompt`.
- Default model strategy:
  - Start with `gemini-2.5-flash` (better free-tier throughput / practical rate behavior).
  - Escalate to `gemini-3-flash-preview` only when needed.
- Escalate to `gemini-3-flash-preview` when:
  - user is unsatisfied with the initial analysis quality,
  - transcript quality is poor or ambiguous,
  - video reasoning is complex and 2.5 output misses important detail.
- If user gives no prompt, use a sensible media-default prompt.
- Keep outputs concise first when long, then provide expanded transcript/details on request.
- Prefer saving output to a file (`> output.txt`) for long transcripts.

## Why save output to file

`gemav` sends media to a remote API for processing (it is not local/offline inference).
For long transcript/analysis runs, write output to disk so you can review it later without rerunning the API call.

## Command patterns

```bash
# Transcript (save to file, default model)
gemav --model gemini-2.5-flash --media "/path/to/file.ogg" \
  --prompt "Transcribe this media verbatim. Mark unclear words as [inaudible]." \
  > transcript.txt

# Video description + transcript (save to file, default model)
gemav --model gemini-2.5-flash --media "/path/to/file.mp4" \
  --prompt "Describe what is happening visually, then provide a verbatim transcript of spoken audio." \
  > video-analysis.txt

# Custom analysis with manual prompt (save to file, default model)
gemav --model gemini-2.5-flash --media "/path/to/file.wav" \
  --prompt "Extract all commitments, owners, and deadlines from speech." \
  > action-items.txt

# Escalation pass for complex/unsatisfying results
gemav --model gemini-3-flash-preview --media "/path/to/file.mp4" \
  --prompt "Re-analyze in higher detail and improve transcript fidelity." \
  > video-analysis-escalated.txt

# Debug JSON (save structured response)
gemav --media "/path/to/file.mp4" --prompt "Transcribe" --json > response.json
```

## Default prompt templates

- Transcript only:
  - `Transcribe this media verbatim. Preserve wording exactly. Mark unclear words as [inaudible].`
- Video + transcript:
  - `Describe key visual events, then provide a verbatim transcript of spoken audio.`
- Spoken action extraction:
  - `Extract decisions, tasks, owners, and deadlines from the speech.`

## Flow

1. Confirm local media path exists.
2. Select user-provided prompt or default media prompt.
3. Run `gemav --media <path> --prompt <prompt>`.
4. Return concise high-signal result first.

## Failure handling

- If file is image-only: switch to native image tooling.
- If auth fails: rerun with `--force-auth`.
- If model capacity/rate-limit: rely on gemav's built-in capacity retries (or tune with `--capacity-retries` / `--retry-base-ms`), then fallback model via `--model`.
- If bad path/type: ask for valid local audio/video path.
