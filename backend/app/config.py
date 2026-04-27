from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _resolve_repo_path(value: str, fallback: Path) -> Path:
    candidate = Path(value) if value else fallback
    if not candidate.is_absolute():
        candidate = (ROOT_DIR / candidate).resolve()
    return candidate.resolve()


@dataclass
class Settings:
    app_name: str = "LabelWe"
    api_prefix: str = "/api/v1"
    secret_key: str = field(default_factory=lambda: os.getenv("SECRET_KEY", secrets.token_urlsafe(32)))
    access_token_hours: int = field(default_factory=lambda: int(os.getenv("ACCESS_TOKEN_HOURS", "12")))
    database_url: str = field(
        default_factory=lambda: os.getenv(
            "DATABASE_URL",
            f"sqlite:///{(ROOT_DIR / 'backend' / 'labelwe.db').as_posix()}",
        )
    )
    storage_root_name: str = field(default_factory=lambda: os.getenv("STORAGE_ROOT_NAME", "workspace-samples"))
    storage_root_path: Path = field(
        default_factory=lambda: _resolve_repo_path(
            os.getenv("STORAGE_ROOT", "./sample-data/images"),
            ROOT_DIR / "sample-data" / "images",
        )
    )
    export_root: Path = field(
        default_factory=lambda: _resolve_repo_path(
            os.getenv("EXPORT_ROOT", "./sample-data/exports"),
            ROOT_DIR / "sample-data" / "exports",
        )
    )
    public_base_url: str = field(default_factory=lambda: os.getenv("PUBLIC_BASE_URL", "http://127.0.0.1:8000"))
    allow_open_registration: bool = field(
        default_factory=lambda: _env_bool("ALLOW_OPEN_REGISTRATION", False)
    )
    seed_demo_users: bool = field(
        default_factory=lambda: _env_bool("SEED_DEMO_USERS", True)
    )
    bootstrap_admin_username: str = field(
        default_factory=lambda: os.getenv("BOOTSTRAP_ADMIN_USERNAME", "").strip()
    )
    bootstrap_admin_password: str = field(
        default_factory=lambda: os.getenv("BOOTSTRAP_ADMIN_PASSWORD", "").strip()
    )
    bootstrap_admin_display_name: str = field(
        default_factory=lambda: os.getenv("BOOTSTRAP_ADMIN_DISPLAY_NAME", "Platform Admin").strip()
        or "Platform Admin"
    )
    cors_origins: list[str] = field(
        default_factory=lambda: [
            item.strip()
            for item in os.getenv(
                "CORS_ORIGINS",
                "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173,http://localhost:4173",
            ).split(",")
            if item.strip()
        ]
    )
    default_labels: list[dict[str, str]] = field(
        default_factory=lambda: [
            {"name": "car", "color": "#ff7a18"},
            {"name": "person", "color": "#00a6fb"},
            {"name": "forklift", "color": "#6a4c93"},
            {"name": "defect", "color": "#ef476f"},
        ]
    )

    def storage_roots(self) -> list[dict[str, str]]:
        self.storage_root_path.mkdir(parents=True, exist_ok=True)
        self.export_root.mkdir(parents=True, exist_ok=True)
        return [{"name": self.storage_root_name, "path": str(self.storage_root_path)}]


settings = Settings()
