# LabelWe

LabelWe is a collaborative image detection annotation platform built from the specification in [docs/图像检测协同标注平台-软件描述.md](e:/work/project/labelwe/docs/图像检测协同标注平台-软件描述.md).

## Workspace layout

- `backend/`: FastAPI service, SQLite-by-default development database, MySQL-compatible SQLAlchemy models, audit trail, task workflow, YOLO export.
- `frontend/`: React + TypeScript + Vite management console, annotation editor, review console, admin pages.
- `prototype/`: standalone interaction prototype used to explore the annotation/review experience before the product UI.
- `sample-data/`: sample images and generated exports used for local validation.
- `docs/`: source product specification and implementation decisions.

## Local development

### Backend

Use the Miniconda Python available in this environment:

```powershell
& 'D:\Program Files\miniconda\python.exe' -m pip install -r backend/requirements.txt
& 'D:\Program Files\miniconda\python.exe' -m uvicorn app.main:app --reload --app-dir backend
```

The API starts at `http://127.0.0.1:8000`, with Swagger UI at `/docs`.

### Frontend

```powershell
cmd /c npm.cmd install --prefix frontend
cmd /c npm.cmd run dev --prefix frontend
```

The frontend starts at `http://127.0.0.1:5173`.

### Seeded demo users

For local development, the backend bootstraps the following users on first start when `SEED_DEMO_USERS` is not set or is `true`:

| Username | Password | Roles |
|----------|----------|-------|
| `admin` | `admin123` | admin, manager, annotator, reviewer |
| `manager` | `manager123` | manager |
| `annotator` | `annotator123` | annotator |
| `reviewer` | `reviewer123` | reviewer |
| `observer` | `observer123` | user |

For production, set `SEED_DEMO_USERS=false` and provide `BOOTSTRAP_ADMIN_USERNAME` plus `BOOTSTRAP_ADMIN_PASSWORD` before the first startup. The backend will create that single initial administrator instead of the demo accounts.

## Tests

### Backend contract and workflow tests

```powershell
& 'D:\Program Files\miniconda\python.exe' -m pytest backend/tests -q
```

### Browser-level validation

The repository includes a Playwright smoke script under `scripts/`. In this environment, browser install or server startup may be constrained. Run it only after backend and frontend dependencies are installed:

```powershell
& 'D:\Program Files\miniconda\python.exe' 'C:\Users\FangzhiMu\.claude\skills\webapp-testing\scripts\with_server.py' --help
```

## Docker and Linux deployment

This workspace ships with `docker-compose.yml`, `backend/Dockerfile`, and `frontend/Dockerfile` for Linux-oriented deployment. Because the current environment is not the production Linux target, treat container startup and reverse-proxy validation as follow-up checks in the deployment environment.

### Use `docker.1ms.run` correctly

If you must pull through `docker.1ms.run`, do not rewrite every image reference to `docker.1ms.run/...` in this repo. In practice that direct-prefix mode may fail for official images with errors such as `manifest ... not found` or `unknown blob`.

Instead, keep the standard image names in this repo and configure Docker on the Linux host to use the `docker.1ms.run` mirror before you run `docker compose build` or `docker compose up`.

Recommended on the Linux host:

```bash
bash <(curl -sSL https://n3.ink/helper) config
systemctl restart docker
```

Manual fallback:

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "registry-mirrors": ["https://docker.1ms.run"]
}
EOF
sudo systemctl restart docker
```

If you insist on using `docker.1ms.run/<image>` directly, the mirror service expects you to log in first. The repository no longer depends on that mode because it is less reliable for the official base images used here.

### Quick Linux deployment with Docker Compose

1. Install Docker Engine and the Compose plugin on the Linux host.
2. Copy or clone this repository to the host, then enter the project directory.
3. Create a production `.env` from the template:

```bash
cp .env.example .env
```

4. Edit `.env` and replace at least these values:

```bash
SECRET_KEY=<a-long-random-secret>
MYSQL_DATABASE=labelwe
MYSQL_USER=labelwe
MYSQL_PASSWORD=<a-strong-db-password>
MYSQL_ROOT_PASSWORD=<a-strong-root-password>
MYSQL_PORT=3306
DATABASE_URL=mysql+pymysql://labelwe:<a-strong-db-password>@db:3306/labelwe?charset=utf8mb4
PUBLIC_BASE_URL=http://<server-ip-or-domain>:8000
VITE_API_BASE_URL=http://<server-ip-or-domain>:8000/api/v1
CORS_ORIGINS=http://<server-ip-or-domain>:4173
HOST_STORAGE_ROOT=/absolute/path/to/source/images
HOST_EXPORT_ROOT=/absolute/path/to/export/output
STORAGE_ROOT=/data/images
EXPORT_ROOT=/data/exports
SEED_DEMO_USERS=false
BOOTSTRAP_ADMIN_USERNAME=<initial-admin-username>
BOOTSTRAP_ADMIN_PASSWORD=<initial-admin-password>
```

`HOST_STORAGE_ROOT` is a Linux host path mounted into backend at `STORAGE_ROOT`; point it to the image directory that managers should browse when creating annotation tasks. `HOST_EXPORT_ROOT` is a Linux host path mounted writable at `EXPORT_ROOT` and stores generated export ZIP files. The application stores container paths in runtime configuration, while Docker maps those paths back to the host directories.

When reviewers complete a review, the backend auto-writes Pascal VOC XML sidecar files (same filename, `.xml` suffix) for passed images into the same folder as each image under `STORAGE_ROOT`. This means `HOST_STORAGE_ROOT` must be mounted writable by backend.

5. Start the stack:

```bash
docker compose up -d --build
```

6. Check service health:

```bash
docker compose ps
docker compose logs -f backend
```

7. Open the app:

- Frontend: `http://<server-ip-or-domain>:4173/`
- API docs: `http://<server-ip-or-domain>:8000/docs`

### Connect MySQL from local Workbench

If the Linux server is reachable from your laptop and firewall/security-group allows TCP `3306`, you can connect directly in MySQL Workbench:

- Hostname: `<server-ip-or-domain>`
- Port: `3306` (or your `.env` `MYSQL_PORT`)
- Username: `labelwe` (or your `.env` `MYSQL_USER`)
- Password: the `.env` `MYSQL_PASSWORD`
- Default Schema: `labelwe` (or your `.env` `MYSQL_DATABASE`)

The Compose file publishes MySQL to the host by default through `${MYSQL_PORT:-3306}:3306`.

For an HTTPS/domain deployment, put Nginx or another reverse proxy in front of the two ports and update `PUBLIC_BASE_URL`, `VITE_API_BASE_URL`, and `CORS_ORIGINS` to the public HTTPS origins before rebuilding the frontend container.

### Build network troubleshooting (pip / uvicorn install failures)

If backend image build fails with messages like `No matching distribution found for uvicorn==...`, the build environment may be using an unavailable/incomplete pip index.

Set pip mirror variables in `.env` and rebuild:

```bash
PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
PIP_TRUSTED_HOST=pypi.tuna.tsinghua.edu.cn
```

Then run:

```bash
docker compose build --no-cache backend
docker compose up -d backend frontend
```

If the frontend shows a new button but backend API still returns `405 Method Not Allowed`, it usually means backend rebuild failed and an old backend image is still running.

If backend startup fails with `RuntimeError: 'cryptography' package is required for sha256_password or caching_sha2_password auth methods`, rebuild the backend image after updating dependencies. MySQL 8 default authentication requires the `cryptography` package when using `PyMySQL`.

### Production hardening notes

- `SECRET_KEY` is required by Docker Compose and must stay stable across restarts, otherwise existing login tokens become invalid.
- MySQL 8 is required for Docker deployment through `DATABASE_URL`; the SQLite fallback is only for direct local development.
- MySQL is published to the host by default at `${MYSQL_PORT:-3306}` for desktop tools such as MySQL Workbench. Restrict this port with firewall/security-group rules.
- The backend image contains the application code. Compose only bind-mounts the source image directory and export directory, not the entire repository.
- `VITE_API_BASE_URL` is compiled into the frontend image. Rebuild the frontend after changing the public API URL or domain.
