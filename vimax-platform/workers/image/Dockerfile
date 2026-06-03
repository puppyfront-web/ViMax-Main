FROM python:3.12-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv

COPY workers/image/pyproject.toml ./workers/image/
RUN cd workers/image && uv pip install --system -e .

COPY workers/image/vimax_image_worker ./workers/image/vimax_image_worker

ENV PYTHONPATH=/app/vimax:/app/workers/image
ENV VIMAX_ROOT=/app/vimax

CMD ["python", "-m", "vimax_image_worker.main"]
