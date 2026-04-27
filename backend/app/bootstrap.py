from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .models import User, UserRole
from .security import hash_password


SEED_USERS = [
    ("admin", "admin123", "System Admin", ["admin", "manager", "annotator", "reviewer"]),
    ("manager", "manager123", "Task Manager", ["manager"]),
    ("annotator", "annotator123", "Annotation Owner", ["annotator"]),
    ("reviewer", "reviewer123", "Primary Reviewer", ["reviewer"]),
    ("observer", "observer123", "Read Only User", ["user"]),
]


def _create_user(db: Session, username: str, password: str, display_name: str, roles: list[str]) -> None:
    user = User(
        username=username,
        password_hash=hash_password(password),
        display_name=display_name,
        is_active=True,
    )
    db.add(user)
    db.flush()
    for role in roles:
        db.add(UserRole(user_id=user.id, role=role))


def seed_users(db: Session) -> None:
    existing = db.scalar(select(User.id).limit(1))
    if existing:
        return

    if settings.bootstrap_admin_username or settings.bootstrap_admin_password:
        if not settings.bootstrap_admin_username or not settings.bootstrap_admin_password:
            raise RuntimeError(
                "BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD must be set together."
            )
        _create_user(
            db,
            settings.bootstrap_admin_username,
            settings.bootstrap_admin_password,
            settings.bootstrap_admin_display_name,
            ["admin", "manager", "annotator", "reviewer"],
        )
        settings.storage_root_path.mkdir(parents=True, exist_ok=True)
        settings.export_root.mkdir(parents=True, exist_ok=True)
        db.commit()
        return

    if not settings.seed_demo_users:
        raise RuntimeError(
            "Database is empty, SEED_DEMO_USERS=false, and no bootstrap admin is configured. "
            "Set BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD for the first startup."
        )

    for username, password, display_name, roles in SEED_USERS:
        _create_user(db, username, password, display_name, roles)

    settings.storage_root_path.mkdir(parents=True, exist_ok=True)
    settings.export_root.mkdir(parents=True, exist_ok=True)
    db.commit()
