"""Shared Linux storage monitoring and protection."""

from __future__ import annotations

import shutil
from pathlib import Path

BACKEND_DIRECTORY = Path(__file__).resolve().parent.parent
STORAGE_DIRECTORY = BACKEND_DIRECTORY / "data"

WARNING_FREE_SPACE_BYTES = 1024 * 1024 * 1024
RESERVE_FREE_SPACE_BYTES = 256 * 1024 * 1024

MINIMUM_COMPRESSED_EXPORT_BYTES = 2 * 1024 * 1024

STORAGE_DIRECTORY.mkdir(
    parents=True,
    exist_ok=True,
)


class StorageError(RuntimeError):
    """Raised when an operation would violate the storage reserve."""


def get_storage_status() -> dict[str, int | bool]:
    """Return current Linux storage capacity and safety state."""
    usage = shutil.disk_usage(
        STORAGE_DIRECTORY
    )

    return {
        "total_bytes": usage.total,
        "used_bytes": usage.used,
        "free_bytes": usage.free,
        "warning_threshold_bytes": WARNING_FREE_SPACE_BYTES,
        "reserve_bytes": RESERVE_FREE_SPACE_BYTES,
        "low": usage.free < WARNING_FREE_SPACE_BYTES,
        "critical": usage.free < RESERVE_FREE_SPACE_BYTES,
    }


def ensure_storage_capacity(
    estimated_output_bytes: int,
    *,
    operation: str,
) -> None:
    """Ensure an operation leaves the protected free-space reserve."""
    estimated_output_bytes = max(
        int(estimated_output_bytes),
        0,
    )

    status = get_storage_status()

    free_bytes = int(
        status["free_bytes"]
    )

    required_free_bytes = (
        estimated_output_bytes
        + RESERVE_FREE_SPACE_BYTES
    )

    if free_bytes >= required_free_bytes:
        return

    free_mb = bytes_to_megabytes(
        free_bytes
    )

    output_mb = bytes_to_megabytes(
        estimated_output_bytes
    )

    reserve_mb = bytes_to_megabytes(
        RESERVE_FREE_SPACE_BYTES
    )

    required_mb = bytes_to_megabytes(
        required_free_bytes
    )

    raise StorageError(
        f"Not enough Linux storage for {operation}. "
        f"The operation is estimated to need about "
        f"{output_mb} MB and OpenBook AI protects a "
        f"{reserve_mb} MB safety reserve. "
        f"About {required_mb} MB free is required, "
        f"but only {free_mb} MB is available."
    )


def estimate_compressed_export_size(
    source_path: Path,
) -> int:
    """Estimate a 64 kbps compressed export from a WAV source."""
    source_size = source_path.stat().st_size

    return max(
        MINIMUM_COMPRESSED_EXPORT_BYTES,
        source_size // 10,
    )


def bytes_to_megabytes(
    value: int,
) -> int:
    """Convert bytes to rounded megabytes."""
    return round(
        value / 1024 / 1024
    )
