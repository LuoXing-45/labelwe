FROM python:3.13-slim

WORKDIR /workspace

ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ARG PIP_EXTRA_INDEX_URL
ARG PIP_TRUSTED_HOST=pypi.tuna.tsinghua.edu.cn

COPY backend/requirements.txt /tmp/requirements.txt
RUN set -eux; \
    if [ -n "${PIP_INDEX_URL:-}" ]; then python -m pip config set global.index-url "${PIP_INDEX_URL}"; fi; \
    if [ -n "${PIP_EXTRA_INDEX_URL:-}" ]; then python -m pip config set global.extra-index-url "${PIP_EXTRA_INDEX_URL}"; fi; \
    if [ -n "${PIP_TRUSTED_HOST:-}" ]; then python -m pip config set global.trusted-host "${PIP_TRUSTED_HOST}"; fi; \
    python -m pip install --no-cache-dir -r /tmp/requirements.txt

COPY . /workspace

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--app-dir", "backend"]
