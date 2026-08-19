"""Safe audiobook storage cleanup scanning and deletion."""

from __future__ import annotations

from pathlib import Path

from sqlmodel import Session, select

from app.audiobook_service import AUDIOBOOK_DIRECTORY
from app.models import AudiobookJob


ACTIVE_JOB_STATUSES = {
    "queued",
    "running",
    "cancelling",
}

INACTIVE_CLEANUP_STATUSES = {
    "failed",
    "cancelled",
}


def _normalize_path(
    path: Path,
) -> Path:
    """Return an absolute lexical path without following file symlinks."""
    return path.absolute()


def _validated_job_anchor(
    job: AudiobookJob,
) -> Path | None:
    """Return a job output anchor only when it belongs to OpenBook AI."""
    if not job.output_path:
        return None

    anchor = Path(
        job.output_path
    )

    try:
        parent = anchor.parent.resolve()
        expected_parent = AUDIOBOOK_DIRECTORY.resolve()
    except OSError:
        return None

    if parent != expected_parent:
        return None

    return _normalize_path(
        anchor
    )


def _job_paths(
    anchor: Path,
) -> dict[str, Path]:
    """Return all known final and temporary paths for one job."""
    wav_path = anchor
    mp3_path = anchor.with_suffix(
        ".mp3"
    )
    m4b_path = anchor.with_suffix(
        ".m4b"
    )

    return {
        "wav": wav_path,
        "mp3": mp3_path,
        "m4b": m4b_path,
        "wav_temporary": wav_path.with_name(
            f".{wav_path.name}.temporary"
        ),
        "mp3_temporary": mp3_path.with_name(
            f".{mp3_path.name}.temporary"
        ),
        "m4b_temporary": m4b_path.with_name(
            f".{m4b_path.name}.temporary"
        ),
        "direct_mp3_temporary": mp3_path.with_name(
            f".{mp3_path.stem}.direct-temporary.mp3"
        ),
        "direct_m4b_audio": m4b_path.with_name(
            f".{m4b_path.stem}.direct-audio.m4a"
        ),
        "direct_m4b_metadata": m4b_path.with_name(
            f".{m4b_path.stem}.direct-metadata.ffmeta"
        ),
        "direct_m4b_temporary": m4b_path.with_name(
            f".{m4b_path.stem}.direct-temporary.m4b"
        ),
    }


def _is_known_temporary_file(
    path: Path,
) -> bool:
    """Return whether a filename matches OpenBook AI temporary output."""
    name = path.name

    if not name.startswith("."):
        return False

    return (
        name.endswith(
            ".temporary"
        )
        or name.endswith(
            ".direct-temporary.mp3"
        )
        or name.endswith(
            ".direct-temporary.m4b"
        )
        or name.endswith(
            ".direct-audio.m4a"
        )
        or name.endswith(
            ".direct-metadata.ffmeta"
        )
    )


def _file_size(
    path: Path,
) -> int:
    """Return a file size, falling back to zero when unavailable."""
    try:
        return max(
            path.stat().st_size,
            0,
        )
    except OSError:
        return 0


def _file_item(
    path: Path,
    *,
    category: str,
    reason: str,
    safe_to_delete: bool,
    job_id: int | None = None,
) -> dict[str, object]:
    """Serialize one cleanup file without exposing arbitrary paths."""
    return {
        "filename": path.name,
        "size_bytes": _file_size(
            path
        ),
        "category": category,
        "reason": reason,
        "safe_to_delete": safe_to_delete,
        "job_id": job_id,
    }


def get_storage_cleanup_summary(
    session: Session,
) -> dict[str, object]:
    """Classify audiobook files by cleanup safety."""
    AUDIOBOOK_DIRECTORY.mkdir(
        parents=True,
        exist_ok=True,
    )

    jobs = session.exec(
        select(AudiobookJob)
    ).all()

    main_path_owners: dict[
        Path,
        AudiobookJob,
    ] = {}

    active_paths: set[Path] = set()

    active_job_count = 0

    for job in jobs:
        anchor = _validated_job_anchor(
            job
        )

        if anchor is None:
            continue

        paths = {
            key: _normalize_path(
                path
            )
            for key, path in _job_paths(
                anchor
            ).items()
        }

        for key in (
            "wav",
            "mp3",
            "m4b",
        ):
            main_path_owners[
                paths[key]
            ] = job

        if job.status in ACTIVE_JOB_STATUSES:
            active_job_count += 1

            active_paths.update(
                paths.values()
            )

    temporary_files: list[
        dict[str, object]
    ] = []

    inactive_artifacts: list[
        dict[str, object]
    ] = []

    orphaned_files: list[
        dict[str, object]
    ] = []

    owned_count = 0
    owned_bytes = 0

    protected_count = 0
    protected_bytes = 0

    total_file_count = 0
    total_bytes = 0

    for path in sorted(
        AUDIOBOOK_DIRECTORY.iterdir(),
        key=lambda item: item.name.lower(),
    ):
        if not path.is_file():
            continue

        total_file_count += 1

        size = _file_size(
            path
        )

        total_bytes += size

        normalized = _normalize_path(
            path
        )

        if path.is_symlink():
            orphaned_files.append(
                _file_item(
                    path,
                    category="orphaned",
                    reason=(
                        "Symbolic links require manual review "
                        "and are never bulk-deleted."
                    ),
                    safe_to_delete=False,
                )
            )
            continue

        if normalized in active_paths:
            protected_count += 1
            protected_bytes += size
            continue

        owner = main_path_owners.get(
            normalized
        )

        if owner is not None:
            if (
                owner.status
                in INACTIVE_CLEANUP_STATUSES
            ):
                inactive_artifacts.append(
                    _file_item(
                        path,
                        category="inactive_artifact",
                        reason=(
                            "Artifact belongs to a failed or "
                            "cancelled audiobook job."
                        ),
                        safe_to_delete=True,
                        job_id=owner.id,
                    )
                )
            else:
                owned_count += 1
                owned_bytes += size

            continue

        if _is_known_temporary_file(
            path
        ):
            temporary_files.append(
                _file_item(
                    path,
                    category="temporary",
                    reason=(
                        "Stale OpenBook AI temporary file "
                        "not protected by an active job."
                    ),
                    safe_to_delete=True,
                )
            )
            continue

        orphaned_files.append(
            _file_item(
                path,
                category="orphaned",
                reason=(
                    "File is not associated with any audiobook "
                    "job. Manual review is required."
                ),
                safe_to_delete=False,
            )
        )

    safe_files = (
        temporary_files
        + inactive_artifacts
    )

    safe_reclaimable_bytes = sum(
        int(
            item["size_bytes"]
        )
        for item in safe_files
    )

    manual_review_bytes = sum(
        int(
            item["size_bytes"]
        )
        for item in orphaned_files
    )

    return {
        "active_job_count": active_job_count,
        "total_file_count": total_file_count,
        "total_bytes": total_bytes,
        "owned_count": owned_count,
        "owned_bytes": owned_bytes,
        "protected_count": protected_count,
        "protected_bytes": protected_bytes,
        "temporary_count": len(
            temporary_files
        ),
        "temporary_bytes": sum(
            int(
                item["size_bytes"]
            )
            for item in temporary_files
        ),
        "inactive_artifact_count": len(
            inactive_artifacts
        ),
        "inactive_artifact_bytes": sum(
            int(
                item["size_bytes"]
            )
            for item in inactive_artifacts
        ),
        "orphaned_count": len(
            orphaned_files
        ),
        "manual_review_bytes": manual_review_bytes,
        "safe_reclaimable_count": len(
            safe_files
        ),
        "safe_reclaimable_bytes": safe_reclaimable_bytes,
        "temporary_files": temporary_files,
        "inactive_artifacts": inactive_artifacts,
        "orphaned_files": orphaned_files,
    }


def cleanup_safe_storage_files(
    session: Session,
) -> dict[str, object]:
    """Delete only files classified as safe cleanup candidates."""
    summary = get_storage_cleanup_summary(
        session
    )

    candidates = [
        *summary["temporary_files"],
        *summary["inactive_artifacts"],
    ]

    audiobook_directory = (
        AUDIOBOOK_DIRECTORY.resolve()
    )

    deleted_files: list[str] = []
    freed_bytes = 0

    for item in candidates:
        filename = str(
            item["filename"]
        )

        path = (
            AUDIOBOOK_DIRECTORY
            / filename
        )

        try:
            if path.parent.resolve() != audiobook_directory:
                continue
        except OSError:
            continue

        if (
            path.is_symlink()
            or not path.is_file()
        ):
            continue

        size = _file_size(
            path
        )

        path.unlink(
            missing_ok=True
        )

        if not path.exists():
            deleted_files.append(
                filename
            )
            freed_bytes += size

    return {
        "deleted_count": len(
            deleted_files
        ),
        "freed_bytes": freed_bytes,
        "deleted_files": deleted_files,
        "summary": get_storage_cleanup_summary(
            session
        ),
    }
