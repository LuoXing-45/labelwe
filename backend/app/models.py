from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def uuid_str() -> str:
    return str(uuid4())


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    display_name: Mapped[str] = mapped_column(String(100))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    roles: Mapped[list["UserRole"]] = relationship("UserRole", back_populates="user", cascade="all, delete-orphan")


class UserRole(Base):
    __tablename__ = "user_roles"
    __table_args__ = (UniqueConstraint("user_id", "role", name="uq_user_role"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(32), index=True)

    user: Mapped[User] = relationship("User", back_populates="roles")


class SourceImage(Base, TimestampMixin):
    __tablename__ = "source_images"
    __table_args__ = (UniqueConstraint("storage_root_ref", "canonical_path", name="uq_source_path"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    storage_root_ref: Mapped[str] = mapped_column(String(100), index=True)
    canonical_path: Mapped[str] = mapped_column(String(500))
    file_hash: Mapped[str] = mapped_column(String(128))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    exif_orientation: Mapped[int] = mapped_column(Integer, default=1)


class AnnotationTask(Base, TimestampMixin):
    __tablename__ = "annotation_tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    title: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(32), default="draft", index=True)
    assignee_user_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), nullable=True, index=True)
    created_by: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True)
    storage_root_ref: Mapped[str] = mapped_column(String(100))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    priority: Mapped[str] = mapped_column(String(24), default="normal")
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class TaskReviewer(Base):
    __tablename__ = "task_reviewers"
    __table_args__ = (UniqueConstraint("task_id", "reviewer_user_id", name="uq_task_reviewer"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    task_id: Mapped[str] = mapped_column(String(36), ForeignKey("annotation_tasks.id", ondelete="CASCADE"), index=True)
    reviewer_user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False)


class TaskImage(Base, TimestampMixin):
    __tablename__ = "task_images"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    task_id: Mapped[str] = mapped_column(String(36), ForeignKey("annotation_tasks.id", ondelete="CASCADE"), index=True)
    source_image_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("source_images.id"), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    file_path: Mapped[str] = mapped_column(String(500))
    file_hash: Mapped[str] = mapped_column(String(128))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    thumb_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    per_image_status: Mapped[str] = mapped_column(String(32), default="not_started", index=True)


class LabelClass(Base, TimestampMixin):
    __tablename__ = "label_classes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    task_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("annotation_tasks.id", ondelete="CASCADE"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(100))
    color: Mapped[str] = mapped_column(String(20))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class WorkingAnnotation(Base):
    __tablename__ = "working_annotations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    task_image_id: Mapped[str] = mapped_column(String(36), ForeignKey("task_images.id", ondelete="CASCADE"), unique=True, index=True)
    payload_json: Mapped[dict] = mapped_column(JSON)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_by: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)


class Submission(Base):
    __tablename__ = "submissions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    task_id: Mapped[str] = mapped_column(String(36), ForeignKey("annotation_tasks.id", ondelete="CASCADE"), index=True)
    submitter_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(32), default="pending_review", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SubmissionImageSnapshot(Base):
    __tablename__ = "submission_image_snapshots"
    __table_args__ = (UniqueConstraint("submission_id", "task_image_id", name="uq_submission_snapshot"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    submission_id: Mapped[str] = mapped_column(String(36), ForeignKey("submissions.id", ondelete="CASCADE"), index=True)
    task_image_id: Mapped[str] = mapped_column(String(36), ForeignKey("task_images.id", ondelete="CASCADE"), index=True)
    payload_json: Mapped[dict] = mapped_column(JSON)


class EffectiveAnnotation(Base):
    __tablename__ = "effective_annotations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    task_image_id: Mapped[str] = mapped_column(String(36), ForeignKey("task_images.id", ondelete="CASCADE"), index=True)
    submission_id: Mapped[str] = mapped_column(String(36), ForeignKey("submissions.id"), index=True)
    payload_json: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ReviewRecord(Base):
    __tablename__ = "review_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    submission_id: Mapped[str] = mapped_column(String(36), ForeignKey("submissions.id", ondelete="CASCADE"), unique=True, index=True)
    reviewer_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"))
    overall_comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    outcome: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class ImageReviewDetail(Base):
    __tablename__ = "image_review_details"
    __table_args__ = (UniqueConstraint("review_record_id", "task_image_id", name="uq_review_image_detail"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    review_record_id: Mapped[str] = mapped_column(String(36), ForeignKey("review_records.id", ondelete="CASCADE"), index=True)
    task_image_id: Mapped[str] = mapped_column(String(36), ForeignKey("task_images.id", ondelete="CASCADE"), index=True)
    decision: Mapped[str] = mapped_column(String(16))
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    example_payload_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    actor_user_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), nullable=True, index=True)
    action_type: Mapped[str] = mapped_column(String(64), index=True)
    target_type: Mapped[str] = mapped_column(String(64), index=True)
    target_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    result: Mapped[str] = mapped_column(String(16), default="success")
    summary: Mapped[str] = mapped_column(String(300))
    before_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    after_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, index=True)
