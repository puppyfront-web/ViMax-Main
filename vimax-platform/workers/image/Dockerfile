FROM python:3.12-slim
WORKDIR /app

ARG INSTALL_FFMPEG=false
RUN if [ "$INSTALL_FFMPEG" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*; \
    fi
RUN pip install --no-cache-dir uv
# pypi.org unreachable from some build environments; default to a mirror (override with --build-arg)
ARG UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV UV_INDEX_URL=${UV_INDEX_URL}

COPY workers/image/pyproject.toml ./workers/image/
RUN cd workers/image && uv pip install --system -e .

COPY workers/image/vimax_image_worker ./workers/image/vimax_image_worker

ENV PYTHONPATH=/app/vimax:/app/workers/image
ENV VIMAX_ROOT=/app/vimax

CMD ["python", "-m", "vimax_image_worker.main"]
