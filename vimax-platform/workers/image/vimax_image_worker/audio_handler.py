"""Audio generation handler — MVP stub that returns a silent WAV file."""
import os
import hashlib
import struct
import asyncio
import logging

from vimax_image_worker.reporter import JobReporter
from vimax_image_worker.asset_uploader import upload_to_s3

log = logging.getLogger("audio-handler")

def _generate_silent_wav(duration_sec: int = 3, sample_rate: int = 44100) -> bytes:
    """Generate a silent WAV file."""
    num_samples = duration_sec * sample_rate
    data_size = num_samples * 2  # 16-bit mono

    header = struct.pack(
        '<4sI4s4sIHHIIHH4sI',
        b'RIFF',
        36 + data_size,
        b'WAVE',
        b'fmt ',
        16,  # chunk size
        1,   # PCM
        1,   # mono
        sample_rate,
        sample_rate * 2,  # byte rate
        2,   # block align
        16,  # bits per sample
        b'data',
        data_size,
    )

    samples = b'\x00\x00' * num_samples
    return header + samples

async def handle_audio_job(payload: dict, reporter: JobReporter):
    """Handle audio generation (MVP: returns silent WAV)."""
    await reporter.publish_started()

    try:
        prompt = payload["input"]["prompt"]
        duration = payload["input"].get("duration_sec", 3)
        callback = payload["callback"]
        bucket = callback["upload_bucket"]
        prefix = callback["upload_prefix"]

        # Generate silent WAV
        wav_data = _generate_silent_wav(duration)

        # Write to temp file
        local_path = f"/tmp/audio_{payload['job_id']}.wav"
        with open(local_path, "wb") as f:
            f.write(wav_data)

        # Upload to S3
        storage_key = f"{prefix}.wav"
        upload_to_s3(local_path, bucket, storage_key)

        # Cleanup
        os.unlink(local_path)

        sha = hashlib.sha256(wav_data).hexdigest()

        await reporter.publish_completed({
            "storage_key": storage_key,
            "width": 0,
            "height": 0,
            "sha256": sha,
            "mime_type": "audio/wav",
            "size_bytes": len(wav_data),
            "duration_sec": duration,
        })

    except Exception as e:
        log.exception("Audio generation failed")
        await reporter.publish_failed("worker.internal", str(e), retryable=False)
