"""Audio generation handler — MVP stub that returns a silent WAV file."""
import hashlib
import logging
import os
import struct
import asyncio
import tempfile
from pathlib import Path

from vimax_image_worker.reporter import JobReporter
from vimax_image_worker.asset_uploader import upload_file

log = logging.getLogger("audio-handler")

def _generate_silent_wav(duration_sec: int = 3, sample_rate: int = 44100) -> bytes:
    """Generate a silent WAV file."""
    num_samples = duration_sec * sample_rate
    data_size = num_samples * 2  # 16-bit mono
    header = b'RIFF'
    header += (36 + data_size).to_bytes(4, 'little')
    header += b'WAVE'
    header += b'fmt '
    header += (16).to_bytes(4, 'little')
    header += struct.pack('<H', 1)  # PCM
    header += struct.pack('<H', 1)  # mono
    header += struct.pack('<I', sample_rate)
    header += struct.pack('<I', sample_rate * 2)  # byte rate
    header += struct.pack('<H', 2)  # block align
    header += struct.pack('<H', 16)  # bits per sample
    header += b'data'
    header += data_size.to_bytes(4, 'little')

    samples = b'\x00\x00' * num_samples
    return header + samples

async def handle_audio_job(payload: dict, reporter: JobReporter):
    """Handle audio generation (MVP: returns silent WAV)."""
    await reporter.started()

    try:
        prompt = payload["input"]["prompt"]
        duration = payload["input"].get("duration_sec", 3)
        callback = payload["callback"]
        bucket = callback["upload_bucket"]
        prefix = callback["upload_prefix"]

        # Generate silent WAV
        wav_data = _generate_silent_wav(duration)

        # Write to a cross-platform temp file
        workdir = tempfile.mkdtemp(prefix=f"vimax-audio-{payload['job_id']}-")
        local_path = Path(workdir) / f"{payload['job_id']}.wav"
        with open(local_path, "wb") as f:
            f.write(wav_data)

        # Upload to S3
        meta = upload_file(local_path, bucket=bucket, prefix=prefix)
        storage_key = meta["storage_key"]

        # Cleanup
        local_path.unlink()
        Path(workdir).rmdir()

        await reporter.completed({
            "storage_key": storage_key,
            "width": 0,
            "height": 0,
            "sha256": meta["sha256"],
            "mime_type": "audio/wav",
            "size_bytes": meta["size_bytes"],
            "duration_sec": duration,
        })

    except Exception as e:
        log.exception("Audio generation failed")
        await reporter.failed(error_code="worker.internal", error_message=str(e), retryable=False)
